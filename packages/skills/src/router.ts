import { generateText, stepCountIs, jsonSchema, type Tool, type LanguageModel } from "ai";
import type { SkillRegistry } from "./registry.js";
import type { Skill } from "./skill.js";
import { isDispatchable, isInlinedExpert } from "./skill.js";
import { cachingOptions } from "./caching-options.js";
import { pruneMessageHistory } from "./message-pruner.js";
import { GROUNDING_PREAMBLE, CLIENTID_FOUNDATION } from "./grounding-preamble.js";
import { currentDatePreamble } from "./date-grounding.js";

/**
 * Max times a sub-agent may call the SAME tool with identical arguments within a
 * single dispatch before the guard short-circuits. >1 so a legitimate re-check
 * still runs; low enough that a runaway loop is cut off fast.
 */
const MAX_IDENTICAL_TOOL_CALLS = 2;

/** Stable stringify (sorted keys) so identical args hash identically regardless
 *  of key order; falls back to a best-effort string on any cycle/serialize error. */
function stableArgKey(args: unknown): string {
  try {
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const sorted = Object.keys(args as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (args as Record<string, unknown>)[k];
          return acc;
        }, {});
      return JSON.stringify(sorted);
    }
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Robustness backstop for sub-agent tool loops. A sub-agent occasionally calls
 * the SAME tool with identical arguments over and over (observed: get_interaction_by_id
 * 20+ times on one id — 152K tokens, ~6 min, never finishing). Wrap each tool so
 * that after MAX_IDENTICAL_TOOL_CALLS identical (tool + args) calls in this
 * dispatch, further identical calls short-circuit with a stop message instead of
 * re-executing — the earlier result already stands, so this burns no tokens/time
 * and nudges the model to finish. Distinct calls and a legitimate re-check are
 * unaffected. Per-dispatch state (fresh Map per invocation) → no cross-request bleed.
 */
export function guardRepeatedToolCalls(
  tools: Record<string, Tool>,
): Record<string, Tool> {
  const counts = new Map<string, number>();
  const guarded: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (typeof execute !== "function") {
      guarded[name] = tool;
      continue;
    }
    guarded[name] = {
      ...tool,
      execute: async (args: unknown, options: unknown) => {
        const key = `${name}:${stableArgKey(args)}`;
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n > MAX_IDENTICAL_TOOL_CALLS) {
          return (
            `Stop: you already called \`${name}\` with these exact arguments ` +
            `${n - 1} time(s) in this task. The earlier result stands — reuse it. ` +
            `Do not call \`${name}\` with the same arguments again; if you have ` +
            `what you need, produce your final answer now.`
          );
        }
        return (execute as (a: unknown, o: unknown) => unknown)(args, options);
      },
    } as Tool;
  }
  return guarded;
}

/**
 * Creates the `execute_skill` meta-tool that the router agent uses
 * to dispatch work to isolated skill sub-agents.
 */
export function createSkillRouterTool(
  registry: SkillRegistry,
  model: LanguageModel,
  getToolsForSkill: (
    mcpToolFilter?: string[],
  ) => Promise<Record<string, Tool>>,
): Tool {
  return {
    description:
      "Execute a skill by name. Routes the input to an isolated sub-agent with the skill's instructions and tools. Use this to delegate work to the appropriate skill.",
    inputSchema: jsonSchema({
      type: "object" as const,
      properties: {
        skillName: {
          type: "string",
          description: "The name of the skill to execute (from the catalog)",
        },
        input: {
          type: "string",
          description: "The task or question to pass to the skill sub-agent",
        },
        operation: {
          type: "string",
          description:
            "Optional operation class (e.g. \"list\", \"get\", \"workflow\") — narrows the sub-agent's tool exposure when the skill's catalog entry shows an Operations: line. Pick the operation that matches the verb in the user's prompt. Omit to give the sub-agent the full tool surface.",
        },
      },
      required: ["skillName", "input"],
    }),
    execute: async ({
      skillName,
      input,
      operation,
    }: {
      skillName: string;
      input: string;
      operation?: string;
    }) => {
      const skill = registry.get(skillName);
      if (!skill) {
        return {
          error: `Unknown skill: "${skillName}". Available: ${registry.list().map((s) => s.name).join(", ")}`,
        };
      }

      // Get tools for action/hybrid skills.
      // - Filter present  → resolver returns the scoped subset (opt-in scoping)
      // - Filter absent   → resolver returns ALL discovered tools (dynamic default)
      // Skill bodies should not name specific tools; the LLM picks from what's
      // available at runtime. Filters exist only when the skill genuinely
      // needs to restrict capabilities (security, focus, multi-server scoping).
      //
      // Pattern A — operation-class dynamic tool filter. When the router LLM
      // passes an `operation` AND the skill declares `operations[op]`, the
      // sub-agent gets that narrower subset instead of the full mcpToolFilter.
      // Falls back to mcpToolFilter on missing/unknown operation — safe by
      // design so a wrong-operation guess never strands the sub-agent.
      let tools: Record<string, Tool> = {};
      if (skill.type !== "expert") {
        const toolFilter =
          operation && skill.operations?.[operation]
            ? skill.operations[operation]
            : skill.mcpToolFilter;
        tools = await getToolsForSkill(toolFilter);
      }

      // Backstop against a sub-agent looping the same tool+args (see
      // guardRepeatedToolCalls). Applied to whatever tool set this dispatch got
      // (operation subset or full filter). Fresh per-dispatch state.
      tools = guardRepeatedToolCalls(tools);

      // Dispatched knowledge experts (`type:"expert"` — inlined experts never
      // reach the dispatch path) get the shared, hardened grounding contract
      // prepended to their curated body: answer only from the body, refuse if
      // uncovered (H6 adjacency + multi-part guards). Injected centrally here
      // rather than hand-authored per SKILL.md so every present and future
      // dispatched expert inherits ONE contract that can't drift. Action/hybrid
      // skills run on their own instructions unchanged.
      // Action/hybrid skills that opt in with `clientIdFoundation: true` get the
      // shared CLIENTID_FOUNDATION block prepended here — the SAME central-inject
      // mechanism as the expert GROUNDING_PREAMBLE above — instead of each SKILL.md
      // hand-copying the 3-case clientId contract into its body (which drifted
      // across ~17 skills). Explicit opt-in, so DRH skills + rpi-clients (no flag)
      // are untouched: one canonical copy that can't drift, zero implicit carve-outs.
      const skillSystem =
        skill.type === "expert"
          ? `${GROUNDING_PREAMBLE}\n\n${skill.instructions}`
          : skill.clientIdFoundation
            ? `${CLIENTID_FOUNDATION}\n\n${skill.instructions}`
            : skill.instructions;
      // The sub-agent that does relative-date math (e.g. rpi-interactions
      // resolving "last 30 days") needs the current date too. Prepend it ONLY to
      // skills that opt in via dateGrounding — blanket-injecting on every
      // sub-agent tipped a borderline rpi-admin tool pick (list-clients
      // regression, #27897). The orchestrator always has the date (chat.ts).
      const system = skill.dateGrounding
        ? `${currentDatePreamble()}\n\n${skillSystem}`
        : skillSystem;

      const { text, toolCalls, steps, totalUsage } = await generateText({
        model,
        system,
        prompt: input,
        tools,
        // Deterministic execution, same rationale as the parent orchestrator:
        // default Azure temperature (~1.0) makes tool selection and argument
        // construction stochastic; temperature 0 pins the sub-agent to the
        // SKILL.md-prescribed behavior for reproducible accuracy.
        temperature: 0,
        stopWhen: stepCountIs(skill.maxSteps),
        // Bound the completion so Azure's TPM admission estimate
        // (prompt + maxOutputTokens) stays small — same reasoning as the
        // parent orchestrator. Unbounded → Azure assumes ~16K → estimate
        // overshoots the 10K window → 429 + retry-after on every call. The
        // sub-agent's real output is ~200 tokens; 3000 is ample (slightly
        // higher than the parent for the synthesis hop) with no truncation.
        maxOutputTokens: 3000,
        // maxRetries: 2 = 3 attempts (1 original + 2 retries). Absorbs the
        // common single AND double transient-burst case — Azure gpt-4o quota
        // throttles often arrive in pairs; "Failed after 2 attempts" with
        // maxRetries: 1 surfaced as visible user noise (live trace 2026-05-21
        // 13:33 on workspace 077e5635). Three-attempt absorption catches that
        // shape; user usually never sees a retry round.
        //
        // INVARIANT (tool 220s < client 240s < Bun idle 255s). The
        // binding constraint is the per-attempt × attempt-count budget against
        // the 240s client cap on a hung provider:
        //   - 3 attempts × ~60s hung worst-realistic ≈ 180s — INSIDE 220s tool.
        //   - 4 attempts (= maxRetries: 3, AI SDK default) × 60s = 240s — at
        //     the client cap. Any further hang reintroduces the silent
        //     socket kill this invariant closes.
        // DO NOT RAISE to maxRetries: 3 without re-running this math + the
        // 240s budget. Retries (config N) ≠ attempts (N+1); read this comment
        // carefully before "just bumping it" again.
        //
        // Parent (orchestrator/executor) uses maxRetries: 0 by design — a
        // different layer (top-level fail-fast on serverless cold-start
        // timeouts, per orchestrator.test.ts:51-52's source pin) vs sub-agent
        // UX absorption here.
        maxRetries: 2,
        // Sub-agent gets the same caching hints as the router. Anthropic
        // benefits most (~90% off cached prefixes); SDK drops keys for
        // inactive providers.
        providerOptions: cachingOptions,
        // Message-array history cap (same hook + utility as the parent
        // orchestrator). Load-bearing here too: an N+1 tool-loop inside one
        // executeSkill turn can overflow gpt-4o's 128K cliff just like the
        // parent's accumulated chat history can. Truncates
        // oldest tool-result content, then drops oldest prunable turns;
        // active turn + system never prunable; throws on catastrophic.
        prepareStep: ({ messages }) => {
          const pruned = pruneMessageHistory(messages);
          return pruned === messages ? {} : { messages: pruned };
        },
      });

      return {
        skillName: skill.name,
        skillType: skill.type,
        result: text,
        toolCallCount: toolCalls?.length ?? 0,
        stepCount: steps?.length ?? 0,
        // Sub-agent's OWN token usage (generation-7 instrumentation), aggregated
        // across this sub-agent's steps. Extracted inline (plain object) so this
        // package keeps no dependency on @redpoint-ai/shared — the parent
        // (chat.ts) reads this from the tool result and emits a role:"sub-agent"
        // event sharing the parent's runId + idempotencyKey. Per-sub-agent
        // breakdown, not a summed total, so cost-by-skill is possible.
        usage: {
          inputTokens: totalUsage?.inputTokens ?? 0,
          outputTokens: totalUsage?.outputTokens ?? 0,
          cacheReadTokens: totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: totalUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
          reasoningTokens: totalUsage?.outputTokenDetails?.reasoningTokens ?? 0,
          totalTokens:
            totalUsage?.totalTokens ??
            (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0),
        },
        // v1.4 minimal sub-agent telemetry. Propagates a name+args summary
        // of every sub-agent tool call up via the execute_skill return
        // shape; parent's trace event auto-serializes the field. No new
        // event types, no AsyncLocalStorage, no `agentLayer` marker —
        // sufficient for chain-test assertions (Path A): "did the sub-agent
        // call `get_<entity>_by_*` with the expected name/id arg?"
        //
        // v1.4.1 bug fix: source from `steps.flatMap(s.toolCalls)`, NOT
        // the top-level `toolCalls` field. Per AI SDK v6 typings (`ai`
        // package `GenerateTextResult.toolCalls`: "The tool calls that
        // were made in the LAST STEP"), top-level toolCalls only captures
        // the final step. Multi-step sub-agents (list → finalize-text)
        // typically end with a final step that has zero tool calls →
        // top-level toolCalls is empty → assertion fails. Live probe
        // confirmed this on the list_clients case before the fix.
        //
        // Token cost in trace JSON: ~100 tokens per execute_skill on a
        // typical chain. Cheap relative to the chain-class assertions it
        // unlocks (v1.1.3 onwards). Full v1.5 (AsyncLocalStorage +
        // agentLayer) stays HOLD — return-based propagation is enough.
        subAgentToolCalls: (steps ?? []).flatMap((step) =>
          (step.toolCalls ?? []).map((tc) => ({
            toolName: tc.toolName,
            args:
              (tc as { input?: unknown; args?: unknown }).input ??
              (tc as { args?: unknown }).args,
          })),
        ),
      };
    },
  };
}

/**
 * Build the router system prompt that includes expert knowledge inline
 * and a compact catalog for actionable (hybrid/action) skills.
 *
 * Expert skills have no tools — their value is knowledge, so we inject
 * their full instructions into the prompt. Hybrid/action skills stay
 * in the catalog for `execute_skill` routing.
 */
export function buildRouterSystemPrompt(
  baseSystemPrompt: string,
  skills: Skill[],
): string {
  // Inlined experts (knowledge folded into the prompt) vs. dispatchable skills
  // (catalog + execute_skill). A `dispatch: true` expert is NOT inlined — it
  // joins the catalog as a tool-less knowledge entry. See isDispatchable.
  const experts = skills.filter(isInlinedExpert);
  const actionable = skills.filter(isDispatchable);

  // Render a domain's *-foundation-expert first in Domain Knowledge — it's the
  // cross-cutting "house style" expert (always-on guidance about clientId,
  // scoping, terminology, error patterns). The other experts are domain-specific
  // and benefit from the foundation framing being read first. Generalized across
  // domains (rpi-foundation-expert, drh-foundation-expert, …). Cosmetic
  // ride-along; runtime identical regardless of order.
  const isFoundation = (name: string) => name.endsWith("-foundation-expert");
  const sortedExperts = [...experts].sort((a, b) =>
    isFoundation(a.name) ? -1 : isFoundation(b.name) ? 1 : 0,
  );

  const sections: string[] = [baseSystemPrompt];

  // Inline expert knowledge directly into the prompt
  if (sortedExperts.length > 0) {
    const expertBlocks = sortedExperts.map(
      (s) => `### ${s.title}\n\n${s.instructions}`,
    );
    sections.push(
      `---\n\n## Domain Knowledge\n\nUse the following domain knowledge to answer user questions directly and authoritatively. Do NOT answer from general knowledge when domain-specific information is available here.\n\n${expertBlocks.join("\n\n")}`,
    );
  }

  // Compact catalog for actionable skills (hybrid/action) — these need execute_skill
  if (actionable.length > 0) {
    const catalogLines = actionable.map((s) => {
      // Dispatched knowledge expert: tool-less by construction —
      // render as a knowledge entry with no Tools:/Operations: line so the
      // router treats it as a WHAT source, not an operation surface.
      if (s.type === "expert") {
        return `- **${s.name}** (knowledge): ${s.description}`;
      }
      const opsLine = s.operations
        ? `\n  Operations: ${Object.keys(s.operations).join(" | ")}`
        : "";
      return `- **${s.name}** (${s.type}): ${s.description}\n  Tools: ${s.mcpToolFilter?.join(", ") ?? "(none)"}${opsLine}`;
    });
    sections.push(
      `---\n\n## Available Skills\n\n${catalogLines.join("\n")}\n\n` +
        `## Routing Guidelines\n\n` +
        `You have access to the \`execute_skill\` tool to delegate tasks to specialized skills.\n\n` +
        `1. **Analyze the user's request** to determine which skill is most appropriate.\n` +
        `2. **Action skills** execute tasks via tools — use them when the user wants to create, modify, or interact with systems.\n` +
        `3. **Hybrid skills** can both advise and act — use them when the task requires both understanding and execution. A hybrid skill's description names broad domains; assume any operation in those domains routes to it (e.g., a "list X" or "find X by Y" request maps to the hybrid skill that covers X's domain).\n` +
        `4. **NEVER ask the user for permission to call execute_skill.** The user's request IS the permission. Do not say "would you like me to..." — just dispatch. Asking is a stall; users want answers, not consent prompts.\n` +
        `5. **Domain-knowledge questions go to the \`(knowledge)\` skill — never answer them from your own knowledge.** Any question about an RPI *concept* or building campaigns with it — definitional ("what is an interaction / audience / selection rule"), explanatory ("how does X work"), or design/strategy ("how do I build X", "what's the best way to Y") — MUST **dispatch via execute_skill to the skill marked \`(knowledge)\`** when one is listed. Do NOT answer such a question from general/parametric knowledge, and do NOT paraphrase it from these inlined notes: the \`(knowledge)\` skill's curated body is the only authoritative source. A confident answer from the wrong source is worse than a thin one from the right source — so route it. Answer *inline* ONLY for cross-cutting **foundation house-style**: client/tenant (\`clientId\`) handling, folder lookups, the bare terminology mapping itself (e.g. "segment" = selection rule), and display/error conventions. A \`(knowledge)\` skill is tool-less: it returns an answer, never performs an operation.\n` +
        `   **This applies to ANY question about the RPI *product*, not only campaign concepts** — its administration, deployment, infrastructure, networking, security/SSO, backup/disaster-recovery, licensing, and pricing all route to the \`(knowledge)\` skill too. **Backstop:** if you do NOT dispatch an RPI-product question for any reason, do NOT answer it from general/training knowledge — say plainly it is not in the curated RPI knowledge and point the user to Redpoint Global documentation or support. Only genuinely **non-RPI** general-knowledge questions may be answered directly.\n` +
        `6. Any request that mentions specific data the user has ("my X", "list X", "count X", "show me X by Y") is an OPERATION, not knowledge — dispatch via execute_skill.\n` +
        `7. You may chain: answer from your knowledge first, then dispatch an action skill to implement.\n` +
        `8. **Carry IDs forward when chaining skills.** When dispatching an action skill that operates on an entity (client, audience, folder, interaction, selection rule, etc.), check prior skill outputs in this conversation. If a previous call already returned that entity's UUID, include the UUID in the \`request\` field — not just the user-typed name. Action skills are filtered to a narrow tool set and generally cannot resolve names themselves, so passing a name when you already have the UUID forces a redundant resolve round-trip. Example: instead of \`request: "List audiences for client Acme-Retail-Demo"\`, pass \`request: "List audiences for client a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890 (Acme-Retail-Demo)"\`. Include the human-readable name in parentheses for the skill's own logging/output, but lead with the UUID so the skill uses it directly. **If the user did NOT name a specific tenant/client, OMIT the client identifier entirely** — the MCP server applies its default client automatically. **NEVER pass a tenant *name* (e.g. "Acme-Retail-Demo") as a client id**: action skills treat it as a UUID, RPI parses a non-UUID to the empty UUID, and the call fails. Lead with a resolved UUID or omit — never a bare name.\n` +
        `9. Always relay the skill's response back to the user clearly.\n` +
        `10. **The Available Skills catalog above is the COMPLETE list of operations you can perform; each skill's \`Tools:\` line is the authoritative capability surface.** Two shapes of capability question:\n` +
        `   - **Broad** ("what can you do?", "what skills do you have?"): enumerate the domains in the catalog.\n` +
        `   - **Verb-specific** ("what can I create?", "what can I run?", "what can I delete?", "what can I update?"): scan the \`Tools:\` lines directly for tool names matching the verb (e.g., \`create_*\`, \`run_*\`, \`delete_*\`, \`update_*\`). LEAD your answer with the matching tools as the primary capabilities — do not bury them inside a domain overview, and do not pivot to negating other entities. If only one tool matches (e.g., only \`create_folder\` matches "create"), say so positively and stop. If none match, say plainly: "That's not exposed by the connected MCP server today."\n` +
        `   The Domain Knowledge sections describe RPI concepts broadly — many concepts are knowledge-only with no operational tool support. Do NOT promise operations you cannot deliver, do not hedge, do not invent constraints, do not claim to have tried it.\n` +
        `11. **When a skill's catalog entry shows an \`Operations:\` line, pass the \`operation\` argument to \`execute_skill\`.** Pick the operation whose name matches the verb in the user's prompt — e.g., a "list X" prompt → \`operation: "list"\`; "get X by name/id" → \`operation: "get"\`; "run workflow / activate / poll status" → \`operation: "workflow"\`. **Intent beats the surface verb:** a request that filters or ranks by a *metric* — "with counts > 0", "non-zero counts", "size > N", "more than M records", "biggest/largest" — is a COUNT intent → \`operation: "count"\` (when the skill offers it), even when the leading word is "list" (e.g. "list selection rules with counts > 0" → \`operation: "count"\`, NOT \`"list"\`). The \`list\` operation cannot compute counts, so a count predicate routed to \`list\` will fail to deliver. The sub-agent receives a narrower tool list and a smaller prompt (faster + cheaper). If unsure, omit \`operation\` and the sub-agent gets the full tool surface — a safe but slower fallback. Never invent operation names; only pass values that appear on the catalog's \`Operations:\` line.`,
    );
  }

  // Reinforce identity at the end — models pay more attention to the end of system prompts
  sections.push(
    `---\n\nRemember: You are a domain expert. Always answer from the Domain Knowledge provided above. Stay in character and do not provide generic or off-topic information.`,
  );

  return sections.join("\n\n");
}
