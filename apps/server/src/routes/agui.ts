import { Hono } from "hono";
import { streamText, stepCountIs, type Tool } from "ai";
import { db } from "../store/db.js";
import { workspaces, threads, runs, messages } from "../store/schema.js";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createModelFromConfig } from "../config/providers.js";
import { mcpManager } from "../mcp/client.js";
import {
  SkillRegistry,
  createSkillRouterTool,
  buildRouterSystemPrompt,
  cachingOptions,
  isDispatchable,
} from "@redpoint-ai/skills";
import { WorkspaceConfigSchema } from "@redpoint-ai/shared";
import { logAudit } from "../lib/audit.js";
// Shared promise-caching singleton. A local copy here assigned the registry
// BEFORE awaiting loadSkillsFromDirectory(), so a second caller arriving during
// boot saw a truthy-but-EMPTY registry — and because the empty registry was
// cached rather than the promise, that degradation was permanent for the
// process, not transient. registry-singleton.ts documents and fixes exactly this.
import { getSkillRegistry } from "../skills/registry-singleton.js";
import { resolveTier } from "../agents/tier-resolver.js";
import { extractListToolsCapability } from "../mcp/mcp-category-discovery.js";
import { appendTrace, truncateForMessage } from "../lib/trace-buffer.js";
import type { TelemetryEvent } from "@redpoint-ai/shared";


export const aguiRoutes = new Hono();

/**
 * POST /api/v1/workspaces/:workspaceId/threads/:threadId/runs/:runId/stream
 *
 * Raw AG-UI event streaming endpoint for third-party agent clients.
 * Emits granular AG-UI protocol events as SSE.
 */
aguiRoutes.post(
  "/:workspaceId/threads/:threadId/runs/:runId/stream",
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const threadId = c.req.param("threadId");
    const runId = c.req.param("runId");

    // Load workspace
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    // Verify thread exists
    const [thread] = await db
      .select()
      .from(threads)
      .where(
        and(eq(threads.id, threadId), eq(threads.workspaceId, workspaceId)),
      );
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    // Verify run exists
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.threadId, threadId)));
    if (!run) return c.json({ error: "Run not found" }, 404);

    const configResult = WorkspaceConfigSchema.safeParse(JSON.parse(workspace.config) as unknown);
    if (!configResult.success) {
      return c.json({ error: "Invalid workspace configuration" }, 400);
    }
    const config = configResult.data;

    // Load thread messages for context
    const threadMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId));

    const prompt =
      threadMessages.length > 0
        ? threadMessages[threadMessages.length - 1].content
        : "";

    // Build model + tools (same logic as chat.ts)
    const model = createModelFromConfig({
      type: config.provider.type,
      model: config.provider.model,
      apiKey: config.provider.apiKey,
      baseUrl: config.provider.baseUrl,
      azureDeployment: config.provider.azureDeployment,
    });

    const mcpTools: Record<string, Tool> = config.mcp?.length
      ? await Promise.race([
          mcpManager.getToolsForWorkspace(workspaceId, config.mcp),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("tool load timed out after 10s — server may be down")),
              10_000,
            ),
          ),
        ])
          .catch((err: unknown) => {
            // Surface, don't swallow: an empty tool map here yields an agent
            // that looks healthy and answers without the tools it advertises.
            // Rethrow so the SSE run reports a failure the caller can see.
            const detail = err instanceof Error ? err.message : String(err);
            console.error(
              `[agui] MCP tools unavailable for workspace ${workspaceId}: ${detail}`,
            );
            throw new Error(
              `Tool server for this workspace is not reachable: ${detail}`,
            );
          })
      : {};

    const tools: Record<string, Tool> = {};
    const registry = await getSkillRegistry();
    const workspaceSkills = config.skills?.length
      ? registry.filterByNames(config.skills)
      : registry.list();
    let systemPrompt =
      config.agent?.systemPrompt || "You are a helpful assistant.";

    // Tier resolution mirrors chat.ts — see docs/architecture.md for the
    // three-way degradation; resolveTier() is the single source of truth.
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
        const scopedRegistry = new SkillRegistry();
        for (const s of workspaceSkills.filter(isDispatchable)) {
          scopedRegistry.register(s);
        }

        tools.execute_skill = createSkillRouterTool(
          scopedRegistry,
          model,
          async (mcpToolFilter) => {
            // Dynamic discovery default: see chat.ts for full rationale.
            // Filter undefined → all discovered tools; filter present → scoped.
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

      systemPrompt = buildRouterSystemPrompt(systemPrompt, workspaceSkills);
    } else {
      Object.assign(tools, mcpTools);
    }

    // Update run status
    await db
      .update(runs)
      .set({ status: "running" })
      .where(eq(runs.id, runId));

    logAudit({
      workspaceId,
      threadId,
      runId,
      action: "run_start",
      details: { model: config.provider.model },
    });

    // SSE stream with AG-UI events
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        const timestamp = new Date().toISOString();

        send({ type: "RUN_STARTED", runId, threadId, timestamp });

        // Telemetry — same TelemetryEvent shape as chat.ts and the terminal
        // agent. Append to the per-workspace trace buffer; readable via
        // GET /api/v1/workspaces/:id/trace.
        const emit = (event: TelemetryEvent) => appendTrace(workspaceId, event);
        let stepCounter = 0;
        const startMs = Date.now();

        emit({
          timestamp: new Date().toISOString(),
          direction: "ToLLM",
          type: "generation-start",
          message: "→ LLM call started",
        });

        try {
          const messageId = randomUUID();
          send({
            type: "TEXT_MESSAGE_START",
            messageId,
            role: "assistant",
            timestamp,
          });

          let fullText = "";

          const result = streamText({
            model,
            system: systemPrompt,
            prompt,
            tools,
            stopWhen: stepCountIs(config.agent?.maxSteps ?? 20),
            // Provider-agnostic prompt caching — see caching-options.ts.
            // SDK drops keys for inactive providers; safe to pass everywhere.
            providerOptions: cachingOptions,
            onStepFinish: ({ toolCalls, toolResults, usage }) => {
              if (toolCalls) {
                for (const tc of toolCalls) {
                  send({
                    type: "TOOL_CALL_START",
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    timestamp: new Date().toISOString(),
                  });
                  send({
                    type: "TOOL_CALL_ARGS",
                    toolCallId: tc.toolCallId,
                    args: JSON.stringify(tc.input),
                  });
                  send({
                    type: "TOOL_CALL_END",
                    toolCallId: tc.toolCallId,
                    timestamp: new Date().toISOString(),
                  });

                  emit({
                    timestamp: new Date().toISOString(),
                    direction: "ToMCP",
                    type: "tool-call",
                    toolName: tc.toolName,
                    args: tc.input,
                    message: `→ ${tc.toolName}(${truncateForMessage(tc.input, 60)})`,
                  });

                  logAudit({
                    workspaceId,
                    threadId,
                    runId,
                    action: "tool_call",
                    details: {
                      toolName: tc.toolName,
                      toolCallId: tc.toolCallId,
                    },
                  });
                }
              }

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
            },
          });

          for await (const chunk of result.textStream) {
            fullText += chunk;
            send({
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta: chunk,
            });
          }

          send({
            type: "TEXT_MESSAGE_END",
            messageId,
            timestamp: new Date().toISOString(),
          });

          // Persist assistant message
          await db.insert(messages).values({
            id: messageId,
            threadId,
            role: "assistant",
            content: fullText,
            createdAt: new Date(),
          });

          // Finalize run
          const usage = await result.usage;
          await db
            .update(runs)
            .set({
              status: "completed",
              promptTokens: usage.inputTokens ?? null,
              completionTokens: usage.outputTokens ?? null,
              totalTokens: usage.totalTokens ?? null,
              finishedAt: new Date(),
            })
            .where(eq(runs.id, runId));

          send({
            type: "RUN_FINISHED",
            runId,
            timestamp: new Date().toISOString(),
          });

          const durationMs = Date.now() - startMs;
          const finalCached = (usage as { inputTokenDetails?: { cacheReadTokens?: number } })
            .inputTokenDetails?.cacheReadTokens;
          const finalCacheCreated = (usage as { inputTokenDetails?: { cacheWriteTokens?: number } })
            .inputTokenDetails?.cacheWriteTokens;
          emit({
            timestamp: new Date().toISOString(),
            direction: "System",
            type: "generation-finish",
            durationMs,
            tokens: {
              in: usage.inputTokens,
              out: usage.outputTokens,
              total: usage.totalTokens,
              ...(finalCached !== undefined ? { cached: finalCached } : {}),
              ...(finalCacheCreated !== undefined ? { cacheCreated: finalCacheCreated } : {}),
            },
            message:
              `● done ${stepCounter} step(s), ${(durationMs / 1000).toFixed(2)}s ` +
              `[total:${usage.totalTokens ?? 0}` +
              (finalCached ? ` cached:${finalCached}` : "") +
              (finalCacheCreated ? ` cacheCreated:${finalCacheCreated}` : "") +
              `]`,
          });

          logAudit({
            workspaceId,
            threadId,
            runId,
            action: "run_end",
            details: { totalTokens: usage.totalTokens },
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          emit({
            timestamp: new Date().toISOString(),
            direction: "System",
            type: "generation-finish",
            error: errorMessage,
            message: `✗ ${errorMessage}`,
          });

          send({
            type: "RUN_ERROR",
            runId,
            error: errorMessage,
            timestamp: new Date().toISOString(),
          });

          await db
            .update(runs)
            .set({ status: "failed", error: errorMessage, finishedAt: new Date() })
            .where(eq(runs.id, runId));

          logAudit({
            workspaceId,
            threadId,
            runId,
            action: "error",
            details: { error: errorMessage },
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  },
);
