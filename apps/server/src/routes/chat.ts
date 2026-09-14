import { Hono } from "hono";
import { createAgentUIStreamResponse, type Tool } from "ai";
import { db } from "../store/db.js";
import { workspaces, runs } from "../store/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createWorkspaceAgent } from "../agents/orchestrator.js";
import { mcpManager } from "../mcp/client.js";
import { readRpiForwardContext } from "../mcp/forward-headers.js";
import { createRenderChartTool, CHART_STEERING } from "../agents/render-chart.js";
import { createRenderStatsTool } from "../agents/render-stats.js";
import { createRenderViewDashboardTool } from "../agents/render-dashboard.js";
import {
  getActiveClient,
  fetchAccessibleClients,
  createTenantSwitchTool,
} from "../mcp/tenant.js";
import {
  SkillRegistry,
  createSkillRouterTool,
  buildRouterSystemPrompt,
  isDispatchable,
  currentDatePreamble,
} from "@redpoint-ai/skills";
import { WorkspaceConfigSchema } from "@redpoint-ai/shared";
import { createModelFromConfig } from "../config/providers.js";
import { logAudit } from "../lib/audit.js";
import { resolveTier } from "../agents/tier-resolver.js";
import { extractListToolsCapability } from "../mcp/mcp-category-discovery.js";
import {
  runsTotal,
  tokensTotal,
  runDuration,
  activeSessions,
  hallucinationsTotal,
} from "./metrics.js";
import { detectHallucination } from "../agents/hallucination-detector.js";
import { getSkillRegistry } from "../skills/registry-singleton.js";
import { appendTrace, truncateForMessage } from "../lib/trace-buffer.js";
import type { TelemetryEvent } from "@redpoint-ai/shared";
import {
  emitInstrumentationEvent,
  isInstrumentationEnabled,
} from "@redpoint-ai/shared";
import {
  resolveUserId,
  resolveIdempotencyKey,
  extractTokenCounts,
  IDEMPOTENCY_HEADER,
} from "../instrumentation/context.js";

// Re-exported for back-compat with existing importers (e.g., A2A server).
export { getSkillRegistry };

/**
 * Ceiling on loading a workspace's MCP tools before we give up and degrade.
 *
 * Mirrors the runtime-status probe fuse. The MCP transport's own timeout is far
 * longer, so an unreachable server does not throw — it stalls, and a chat
 * request with no fuse simply never returns. 10s is generous for a handshake
 * plus tools/list on a live server and short enough that a dead one produces an
 * error the user can act on.
 */
const MCP_TOOL_LOAD_TIMEOUT_MS = 10_000;

export const chatRoutes = new Hono();

/**
 * POST /api/v1/workspaces/:workspaceId/chat
 *
 * useChat-compatible endpoint. Accepts UI messages from the frontend,
 * runs the agent, and returns a UI message stream response.
 *
 * The frontend's useChat hook sends messages in UIMessage format:
 *   [{ id, role, parts: [{ type: "text", text: "..." }] }]
 */
chatRoutes.post("/:workspaceId/chat", async (c) => {
  const workspaceId = c.req.param("workspaceId");

  // Load workspace config
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) return c.json({ error: "Workspace not found" }, 404);

  const configResult = WorkspaceConfigSchema.safeParse(JSON.parse(workspace.config) as unknown);
  if (!configResult.success) {
    return c.json({ error: "Invalid workspace configuration" }, 400);
  }
  const config = configResult.data;
  const body = await c.req.json();
  const { messages: uiMessages } = body;

  if (!uiMessages || !Array.isArray(uiMessages)) {
    return c.json({ error: "messages array is required" }, 400);
  }

  // #27828 — per-conversation tenant. The AI SDK / assistant-ui transport sends
  // the chat id as `body.id` (already arriving; the app just hadn't read it).
  // It keys the conversation's active RPI client. Absent → no per-conversation
  // state this request (falls back to the deployment default).
  const conversationId =
    typeof body?.id === "string" && body.id ? body.id : undefined;
  // Per-USER isolation guard: the tenant selection is scoped to the caller so a
  // shared conversation id can't leak one user's active tenant to another. The
  // auth middleware sets c.get("user"); dev/open mode → a stable dev id.
  const tenantUserId = c.get("user")?.id ?? "anonymous";

  // Per-user RPI auth — the web client (apps/web/components/chat/chat-panel.tsx)
  // reads `session.rpi.accessToken` from the NextAuth session and forwards it
  // here as `X-RPI-Token`. We pass it through to the MCP client manager,
  // which builds an ephemeral client with that Bearer baked into the
  // transport for the duration of THIS request (no cache write). When the
  // header is absent, the cached proxy-user path is used — preserving the
  // pre-PR behavior for unauthenticated chats and for non-web callers (e.g.
  // direct API consumers).
  //
  // The header carries just the raw token (no "Bearer " prefix). The MCP
  // client manager rebuilds the conventional Authorization header inside
  // getToolsForWorkspace() before threading it down to the transport.
  //
  // Both X-RPI-Token and X-RPI-URL (the per-request Environment Location, already
  // SSRF-validated by the auth middleware) come from ONE shared reader so this
  // route and the runtime-status handler thread the identical pair — undefined
  // url = default instance.
  const { userRpiToken, userRpiUrl } = readRpiForwardContext(c);

  // #27828 — resolve THIS conversation's active RPI client (tenant) for THIS
  // user, threaded per-request into the MCP tools below as X-ClientID. Undefined
  // → getToolsForWorkspace falls back to RPI_DEFAULT_CLIENT_ID.
  //
  // Held in a MUTABLE per-request cell (never a singleton — no cross-request /
  // cross-user bleed) so a mid-turn set_active_tenant switch applies to the
  // SUBSEQUENT RPI tool calls in the SAME turn: the MCP execute wrappers read
  // clientRef.current at CALL time, and set_active_tenant's onSwitch updates it
  // right after it persists the change.
  const activeClient = await getActiveClient(
    conversationId,
    tenantUserId,
    workspaceId,
  );
  const clientRef = { current: activeClient?.id };

  // Load MCP tools if workspace has MCP connections configured.
  //
  // An unreachable MCP server used to throw straight out of the route as a 500.
  // Degrade instead — but SURFACE it, never swallow it: continuing silently with
  // an empty tool map produces an agent that looks healthy and answers without
  // the tools it claims, which is the exact silent degradation this endpoint has
  // already been bitten by. Loud-but-wrong beats quiet-and-wrong.
  let mcpTools: Record<string, Tool> = {};
  let mcpFailure: string | null = null;
  if (config.mcp?.length) {
    try {
      // Bounded at MCP_TOOL_LOAD_TIMEOUT_MS (10s) — the SAME fuse the runtime-status
      // probe now uses (workspaces.ts), so a slow-but-valid load behaves identically in
      // both paths (they previously differed: chat 10s vs panel 5s). An unreachable MCP
      // server does not fail fast — the transport waits out its own long default — so
      // without a fuse the request HANGS rather than erroring, and the user gets an
      // endless spinner instead of an answer. Measured at >90s against a stopped
      // container before this fuse existed.
      mcpTools = await Promise.race([
        mcpManager.getToolsForWorkspace(workspaceId, config.mcp, userRpiToken, userRpiUrl, () => clientRef.current),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `tool load timed out after ${MCP_TOOL_LOAD_TIMEOUT_MS / 1000}s — server may be down`,
                ),
              ),
            MCP_TOOL_LOAD_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      mcpFailure = err instanceof Error ? err.message : String(err);
      console.error(
        `[chat] MCP tools unavailable for workspace ${workspaceId}: ${mcpFailure}`,
      );
    }
  }

  // Tools were configured but none could be loaded — tell the user plainly
  // rather than answering as a tool-less agent pretending to be whole.
  if (mcpFailure !== null) {
    const names = (config.mcp ?? []).map((m) => m.name).join(", ");
    return c.json(
      {
        error: "mcp_unavailable",
        message:
          `The tool server${names ? ` (${names})` : ""} for this workspace is not reachable, ` +
          `so its tools are unavailable. Check that the MCP server is running and configured, ` +
          `then try again.`,
      },
      503,
    );
  }

  // Build tools map for the router agent
  const tools: Record<string, Tool> = {};

  const registry = await getSkillRegistry();
  // Filter skills by workspace config — if config.skills is set, only those skills are available
  const workspaceSkills = config.skills?.length
    ? registry.filterByNames(config.skills)
    : registry.list();
  let systemPrompt =
    config.agent?.systemPrompt || "You are a helpful assistant.";

  // Ground the model in the CURRENT date, computed server-side per request (UTC).
  // Without it the model falls back to its stale training-cutoff date and resolves
  // relative ranges ("this month", "last 30 days") into a past window that returns
  // zero rows for present-day data (#27897). Prefixed to the base prompt so it
  // leads the composed router prompt (buildRouterSystemPrompt puts base first).
  systemPrompt = `${currentDatePreamble()}\n\n${systemPrompt}`;

  // Resolve the active tool-exposure tier (see docs/architecture.md). Tier 2
  // (category-discovery) chat-route wiring is still deferred — for workspaces
  // that resolve to "category-discovery" we currently fall through to the
  // experts-only knowledge path (no tools added), same as before. The single
  // resolveTier() call gives us a stable label for logging + the new
  // runtime-status endpoint to read.
  const mcpCaps = (config.mcp ?? []).map((conn) => {
    const transport = mcpManager.getTransport(workspaceId, conn.name);
    return {
      supportsFiltering: transport
        ? !!extractListToolsCapability(transport)?.supportsFiltering
        : false,
    };
  });
  const tier = resolveTier(workspaceSkills, mcpCaps);

  if (workspaceSkills.length > 0) {
    if (tier === "skill-router") {
      // Actionable skills available: router gets execute_skill for hybrid/action skills.
      // MCP tools flow exclusively through skill sub-agents.
      const model = createModelFromConfig({
        type: config.provider.type,
        model: config.provider.model,
        apiKey: config.provider.apiKey,
        baseUrl: config.provider.baseUrl,
        azureDeployment: config.provider.azureDeployment,
      });

      // Build a scoped registry so execute_skill only accepts workspace skills
      const scopedRegistry = new SkillRegistry();
      for (const s of workspaceSkills.filter(isDispatchable)) {
        scopedRegistry.register(s);
      }

      tools.execute_skill = createSkillRouterTool(
        scopedRegistry,
        model,
        async (mcpToolFilter) => {
          // Dynamic discovery default: if the skill omits mcpToolFilter, the
          // sub-agent gets ALL discovered MCP tools at runtime. Filter is
          // opt-in scoping for skills that need to restrict capabilities.
          // Skill bodies should not list specific tool names; let the LLM
          // pick from the live set so skills survive upstream tool churn.
          if (!mcpToolFilter) return mcpTools;
          const filtered: Record<string, Tool> = {};
          for (const [name, tool] of Object.entries(mcpTools)) {
            const baseName = name.includes("__")
              ? name.split("__").pop()!
              : name;
            if (mcpToolFilter.includes(baseName)) {
              filtered[name] = tool;
            }
          }
          return filtered;
        },
      );
    }

    // Build system prompt with expert knowledge inlined + actionable skill catalog
    systemPrompt = buildRouterSystemPrompt(systemPrompt, workspaceSkills);
  } else {
    // No skills loaded: pass MCP tools directly to the agent
    Object.assign(tools, mcpTools);
  }

  // #27828 — LLM-driven tenant switch. An apps/server ORCHESTRATOR tool (added to
  // the router's own toolset, both tiers), NOT an mcp-rpi tool: RBAC validation +
  // per-conversation persistence live server-side, so mcp-rpi's read-only write-
  // gate never touches it. Gated on an RPI connection (tenant = an RPI concept).
  // Its RBAC list is fetched as the caller (user token + this request's instance).
  if (config.mcp?.some((m) => m.name === "rpi")) {
    tools.set_active_tenant = createTenantSwitchTool({
      conversationId,
      userId: tenantUserId,
      workspaceId,
      listClients: () => fetchAccessibleClients(userRpiToken, userRpiUrl),
      // Apply the switch to the rest of THIS turn: the MCP execute wrappers read
      // clientRef.current at call time, so subsequent RPI calls this turn use the
      // just-switched X-ClientID (not just the next turn's store read).
      onSwitch: (clientId) => {
        clientRef.current = clientId;
      },
    });
  }

  // #27897 — render_chart: an orchestrator tool available in every tier. The
  // agent calls it with a schema-validated chart spec AFTER fetching data via the
  // RPI/DRH tools; assistant-ui renders <AgentChart> from the tool args. No data
  // plumbing (the data rides in the spec), so it's unconditional.
  tools.render_chart = createRenderChartTool();
  // Steer the orchestrator to actually CALL render_chart on a chart request
  // (the tool description alone didn't reliably trigger it). Appended here so the
  // guidance is present wherever the tool is — every tier and every workspace,
  // including the no-skills branch that skips buildRouterSystemPrompt.
  systemPrompt = `${systemPrompt}\n\n---\n\n${CHART_STEERING}`;

  // #27897 P2 — render_stats: KPI stat-tiles, the summary cards atop a dashboard
  // view. Orchestrator tool, every tier (like render_chart); args ride to the
  // frontend tool-UI (<StatTiles>). No data plumbing (data rides in the spec).
  tools.render_stats = createRenderStatsTool();

  // #27957 P2 — render_view_dashboard: the DETERMINISTIC dashboard. The LLM picks
  // a viewId + params; execute() fetches (via the authed per-user mcpTools map)
  // and assembles the spec in code, then RETURNS it. The tool-UI renders from the
  // RESULT (<AgentDashboard>), so composition leaves the model — no panel-drop
  // variance. Every tier; a new view is one registry entry.
  tools.render_view_dashboard = createRenderViewDashboardTool({ mcpTools });

  // Create agent from workspace config
  const agent = createWorkspaceAgent({
    systemPrompt,
    model: config.provider.model,
    providerType: config.provider.type,
    maxSteps: config.agent?.maxSteps,
    apiKey: config.provider.apiKey,
    baseUrl: config.provider.baseUrl,
    azureDeployment: config.provider.azureDeployment,
    tools,
  });

  const startTime = Date.now();
  const runId = randomUUID();

  // Telemetry event helper — appends a TelemetryEvent to the per-workspace
  // trace buffer. Verbatim shape matches the terminal agent's TelemetryEvent
  // so a web export and a terminal export are drop-in interchangeable.
  const emit = (event: TelemetryEvent) => appendTrace(workspaceId, event);
  let stepCounter = 0;

  // createAgentUIStreamResponse's onFinish event carries NO usage (only messages/
  // finishReason) — usage is populated only per-step in onStepFinish. Accumulate the
  // turn's own token totals here so onFinish can record runs/metrics and emit the
  // parent instrumentation event. Parent tokens ONLY — sub-agent usage is Step 4.
  const usageAcc = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  let sawUsage = false;

  // Instrumentation identity — resolved ONCE so the parent and every sub-agent
  // event share identical userId + idempotencyKey (the correlation the Step-6
  // report groups on). Gate snapshotted at request start: when off, nothing is
  // resolved or built.
  const instrumentationOn = isInstrumentationEnabled();
  const instrUserId = instrumentationOn ? resolveUserId(c.get("user")) : "";
  const instrIdempotencyKey = instrumentationOn
    ? resolveIdempotencyKey(c.req.header(IDEMPOTENCY_HEADER), runId)
    : "";

  try {
    activeSessions.inc();
    logAudit({ workspaceId, runId, action: "run_start", details: { model: config.provider.model, provider: config.provider.type } });

    // generation-start (ToLLM) — emitted at the start of the run
    emit({
      timestamp: new Date().toISOString(),
      direction: "ToLLM",
      type: "generation-start",
      message: "→ LLM call started",
    });

    return createAgentUIStreamResponse({
      agent,
      uiMessages,
      onStepFinish: ({ text, toolCalls, toolResults, usage }) => {
        // Per-tool-call events (ToMCP) — one tool-call event per call in the step
        for (const tc of toolCalls ?? []) {
          const toolName = tc.toolName ?? "unknown";
          const args = (tc as { input?: unknown; args?: unknown }).input ?? (tc as { args?: unknown }).args;
          emit({
            timestamp: new Date().toISOString(),
            direction: "ToMCP",
            type: "tool-call",
            toolName,
            args,
            message: `→ ${toolName}(${truncateForMessage(args, 60)})`,
          });
        }

        // Per-tool-result events (FromMCP) — one tool-result event per result
        for (const tr of (toolResults as unknown[]) ?? []) {
          const r = tr as { toolName?: string; output?: unknown; result?: unknown; error?: unknown };
          const toolName = r.toolName ?? "unknown";
          const result = r.output ?? r.result;
          const error = r.error ? String(r.error) : undefined;
          emit({
            timestamp: new Date().toISOString(),
            direction: "FromMCP",
            type: "tool-result",
            toolName,
            ...(error ? { error } : { result }),
            message: error ? `← ${toolName} FAILED` : `← ${toolName} OK`,
          });
        }

        // Sub-agent instrumentation — one role:"sub-agent" event
        // per execute_skill result, carrying that sub-agent's OWN usage (from
        // router.ts's return) + skillName, and sharing the parent's runId +
        // idempotencyKey (the Step-6 dedup grain). Per-sub-agent breakdown, not a
        // summed total. Gate snapshotted at request start → nothing built when off.
        if (instrumentationOn) {
          for (const tr of (toolResults as unknown[]) ?? []) {
            const r = tr as { toolName?: string; output?: unknown; result?: unknown };
            if (r.toolName !== "execute_skill") continue;
            const out = (r.output ?? r.result) as
              | {
                  skillName?: string;
                  usage?: {
                    inputTokens?: number;
                    outputTokens?: number;
                    cacheReadTokens?: number;
                    cacheWriteTokens?: number;
                    reasoningTokens?: number;
                    totalTokens?: number;
                  };
                }
              | undefined;
            if (!out?.usage) continue;
            emitInstrumentationEvent({
              eventId: randomUUID(),
              timestamp: new Date().toISOString(),
              userId: instrUserId,
              idempotencyKey: instrIdempotencyKey,
              clientId: "web",
              model: config.provider.model,
              provider: config.provider.type,
              inputTokens: out.usage.inputTokens ?? 0,
              outputTokens: out.usage.outputTokens ?? 0,
              cacheReadTokens: out.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: out.usage.cacheWriteTokens ?? 0,
              reasoningTokens: out.usage.reasoningTokens ?? 0,
              totalTokens: out.usage.totalTokens ?? 0,
              workspaceId,
              runId,
              role: "sub-agent",
              skillName: out.skillName,
            });
          }
        }

        // step-finish (FromLLM) — token usage for this step. Cache fields
        // come from usage.inputTokenDetails (AI SDK 6); when populated they
        // append cached:N / cacheCreated:N to the message — turn-2 of any
        // multi-turn chat shows cached:N as binary verification that prompt
        // caching is firing (see packages/skills/src/caching-options.ts).
        stepCounter += 1;
        if (usage) {
          // Accumulate this step into the turn's parent totals (the only place
          // usage is populated for this stream).
          const t = extractTokenCounts(usage);
          usageAcc.inputTokens += t.inputTokens;
          usageAcc.outputTokens += t.outputTokens;
          usageAcc.cacheReadTokens += t.cacheReadTokens;
          usageAcc.cacheWriteTokens += t.cacheWriteTokens;
          usageAcc.reasoningTokens += t.reasoningTokens;
          usageAcc.totalTokens += t.totalTokens;
          sawUsage = true;

          const cached = usage.inputTokenDetails?.cacheReadTokens;
          const cacheCreated = usage.inputTokenDetails?.cacheWriteTokens;
          const cacheStr =
            (cached ? ` cached:${cached}` : "") +
            (cacheCreated ? ` cacheCreated:${cacheCreated}` : "");
          emit({
            timestamp: new Date().toISOString(),
            direction: "FromLLM",
            type: "step-finish",
            tokens: {
              in: usage.inputTokens,
              out: usage.outputTokens,
              total: usage.totalTokens,
              ...(cached !== undefined ? { cached } : {}),
              ...(cacheCreated !== undefined ? { cacheCreated } : {}),
            },
            message: `← step ${stepCounter} [in:${usage.inputTokens ?? 0} out:${usage.outputTokens ?? 0}${cacheStr}]`,
          });
        }

        if (detectHallucination(text, toolCalls as unknown[])) {
          hallucinationsTotal.inc({ provider: config.provider.type });
          logAudit({
            workspaceId,
            runId,
            action: "hallucination_detected",
            details: { provider: config.provider.type, textPreview: text.slice(0, 200) },
          });
        }
      },
      onError: (error) => {
        activeSessions.dec();
        runsTotal.inc({ status: "failed", provider: config.provider.type });
        const msg = error instanceof Error ? error.message : String(error);
        emit({
          timestamp: new Date().toISOString(),
          direction: "System",
          type: "generation-finish",
          error: msg,
          message: `✗ ${msg}`,
        });
        logAudit({
          workspaceId,
          runId,
          action: "error",
          details: { error: msg },
        });
        return msg;
      },
      onFinish: async () => {
        // createAgentUIStreamResponse's onFinish event carries NO usage (only
        // messages/finishReason) — the turn's token totals were accumulated per
        // step in onStepFinish (usageAcc). Use those here.
        activeSessions.dec();
        const durationSec = (Date.now() - startTime) / 1000;
        runDuration.observe(durationSec);
        runsTotal.inc({ status: "completed", provider: config.provider.type });

        emit({
          timestamp: new Date().toISOString(),
          direction: "System",
          type: "generation-finish",
          durationMs: Math.round(Date.now() - startTime),
          tokens: sawUsage
            ? {
                in: usageAcc.inputTokens,
                out: usageAcc.outputTokens,
                total: usageAcc.totalTokens,
                ...(usageAcc.cacheReadTokens
                  ? { cached: usageAcc.cacheReadTokens }
                  : {}),
                ...(usageAcc.cacheWriteTokens
                  ? { cacheCreated: usageAcc.cacheWriteTokens }
                  : {}),
              }
            : undefined,
          message:
            `● done ${stepCounter} step(s), ${durationSec.toFixed(2)}s ` +
            `[total:${usageAcc.totalTokens}` +
            (usageAcc.cacheReadTokens ? ` cached:${usageAcc.cacheReadTokens}` : "") +
            (usageAcc.cacheWriteTokens
              ? ` cacheCreated:${usageAcc.cacheWriteTokens}`
              : "") +
            `]`,
        });

        if (sawUsage) {
          tokensTotal.inc({ type: "input" }, usageAcc.inputTokens);
          tokensTotal.inc({ type: "output" }, usageAcc.outputTokens);

          await db.insert(runs).values({
            id: runId,
            threadId: "ephemeral",
            status: "completed",
            promptTokens: usageAcc.inputTokens,
            completionTokens: usageAcc.outputTokens,
            totalTokens: usageAcc.totalTokens,
            createdAt: new Date(),
            finishedAt: new Date(),
          });
        }

        // Economic-viability instrumentation — the parent turn's own usage as one
        // event (role "parent"); execute_skill sub-agents emit their own events
        // above. Gate checked FIRST so nothing is built when off.
        if (instrumentationOn && sawUsage) {
          emitInstrumentationEvent({
            eventId: randomUUID(),
            timestamp: new Date().toISOString(),
            userId: instrUserId,
            idempotencyKey: instrIdempotencyKey,
            clientId: "web", // emitting channel; tenant is workspaceId
            model: config.provider.model,
            provider: config.provider.type,
            ...usageAcc,
            workspaceId,
            runId,
            role: "parent",
          });
        }

        logAudit({ workspaceId, runId, action: "run_end", details: { durationSec, inputTokens: usageAcc.inputTokens, outputTokens: usageAcc.outputTokens } });
      },
    });
  } catch (error) {
    activeSessions.dec();
    runsTotal.inc({ status: "failed", provider: config.provider.type });
    logAudit({
      workspaceId,
      runId,
      action: "error",
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
});
