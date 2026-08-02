import { Hono } from "hono";
import { createAgentUIStreamResponse, type Tool, type LanguageModelUsage } from "ai";
import { db } from "../store/db.js";
import { workspaces, runs } from "../store/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createWorkspaceAgent } from "../agents/orchestrator.js";
import { mcpManager } from "../mcp/client.js";
import {
  SkillRegistry,
  createSkillRouterTool,
  buildRouterSystemPrompt,
  isDispatchable,
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
  const { messages: uiMessages } = await c.req.json();

  if (!uiMessages || !Array.isArray(uiMessages)) {
    return c.json({ error: "messages array is required" }, 400);
  }

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
  const userRpiToken = c.req.header("x-rpi-token") ?? undefined;

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
      // Bounded, like the runtime-status probe. An unreachable MCP server does
      // not fail fast — the transport waits out its own long default — so
      // without a fuse the request HANGS rather than erroring, and the user
      // gets an endless spinner instead of an answer. Measured at >90s against
      // a stopped container before this fuse existed.
      mcpTools = await Promise.race([
        mcpManager.getToolsForWorkspace(workspaceId, config.mcp, userRpiToken),
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

        // step-finish (FromLLM) — token usage for this step. Cache fields
        // come from usage.inputTokenDetails (AI SDK 6); when populated they
        // append cached:N / cacheCreated:N to the message — turn-2 of any
        // multi-turn chat shows cached:N as binary verification that prompt
        // caching is firing (see packages/skills/src/caching-options.ts).
        stepCounter += 1;
        if (usage) {
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
      onFinish: async (event) => {
        // createAgentUIStreamResponse's onFinish arg doesn't type `usage`; read
        // it defensively (all uses below are already `usage?`-guarded).
        const usage = (event as { usage?: LanguageModelUsage }).usage;
        activeSessions.dec();
        const durationSec = (Date.now() - startTime) / 1000;
        runDuration.observe(durationSec);
        runsTotal.inc({ status: "completed", provider: config.provider.type });

        const finalCached = usage?.inputTokenDetails?.cacheReadTokens;
        const finalCacheCreated = usage?.inputTokenDetails?.cacheWriteTokens;
        emit({
          timestamp: new Date().toISOString(),
          direction: "System",
          type: "generation-finish",
          durationMs: Math.round((Date.now() - startTime)),
          tokens: usage
            ? {
                in: usage.inputTokens,
                out: usage.outputTokens,
                total: usage.totalTokens,
                ...(finalCached !== undefined ? { cached: finalCached } : {}),
                ...(finalCacheCreated !== undefined
                  ? { cacheCreated: finalCacheCreated }
                  : {}),
              }
            : undefined,
          message:
            `● done ${stepCounter} step(s), ${durationSec.toFixed(2)}s ` +
            `[total:${usage?.totalTokens ?? 0}` +
            (finalCached ? ` cached:${finalCached}` : "") +
            (finalCacheCreated ? ` cacheCreated:${finalCacheCreated}` : "") +
            `]`,
        });

        if (usage) {
          tokensTotal.inc({ type: "input" }, usage.inputTokens ?? 0);
          tokensTotal.inc({ type: "output" }, usage.outputTokens ?? 0);

          await db.insert(runs).values({
            id: runId,
            threadId: "ephemeral",
            status: "completed",
            promptTokens: usage.inputTokens ?? null,
            completionTokens: usage.outputTokens ?? null,
            totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            createdAt: new Date(),
            finishedAt: new Date(),
          });
        }

        logAudit({ workspaceId, runId, action: "run_end", details: { durationSec, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens } });
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
