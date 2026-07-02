/**
 * WorkspaceExecutor — implements A2A `AgentExecutor`.
 *
 * Each A2A request is routed through a configured workspace:
 *   1. Extract the user text from the incoming A2A Message
 *   2. Load the workspace config from the database
 *   3. Build the same tool set as the chat route (skills + MCP)
 *   4. Run the agent (non-streaming — A2A Phase 1 does not stream)
 *   5. Publish the result as an A2A Message on the event bus
 *
 * Workspace is configured at startup via the A2A_WORKSPACE_ID env var. All A2A
 * requests run through that single workspace. Per-request workspace routing
 * (via A2A metadata) is deferred.
 *
 * Ported from RP-Vercel-Agent v3 (src/a2a/server/executor.ts) with adaptation
 * for RP_AI's workspace-based architecture.
 */

import { randomUUID } from "node:crypto";
import { generateText, stepCountIs, type Tool } from "ai";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { eq } from "drizzle-orm";
import { db } from "../store/db.js";
import { workspaces } from "../store/schema.js";
import { WorkspaceConfigSchema } from "@redpoint-ai/shared";
import { createModelFromConfig } from "../config/providers.js";
import { mcpManager } from "../mcp/client.js";
import {
  SkillRegistry,
  createSkillRouterTool,
  buildRouterSystemPrompt,
  isDispatchable,
} from "@redpoint-ai/skills";

export interface ExecutorDeps {
  /** Workspace ID to route all A2A requests through */
  workspaceId: string;
  /** Pre-loaded skill registry (shared with chat route) */
  skillRegistry: SkillRegistry;
}

/**
 * Extract the first text part from an incoming A2A message.
 * Phase 1 only handles `kind: "text"` parts — data/file parts are ignored.
 */
function extractText(message: Message): string {
  for (const part of message.parts) {
    if (part.kind === "text") return part.text;
  }
  return "";
}

export class WorkspaceExecutor implements AgentExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    try {
      const userText = extractText(requestContext.userMessage);

      // Load the configured workspace
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, this.deps.workspaceId));

      if (!workspace) {
        throw new Error(`A2A workspace "${this.deps.workspaceId}" not found`);
      }

      const configResult = WorkspaceConfigSchema.safeParse(
        JSON.parse(workspace.config) as unknown,
      );
      if (!configResult.success) {
        throw new Error("Invalid A2A workspace configuration");
      }
      const config = configResult.data;

      // Build tools the same way chat.ts does
      const mcpTools: Record<string, Tool> = config.mcp?.length
        ? await mcpManager.getToolsForWorkspace(this.deps.workspaceId, config.mcp)
        : {};

      const tools: Record<string, Tool> = {};
      const workspaceSkills = config.skills?.length
        ? this.deps.skillRegistry.filterByNames(config.skills)
        : this.deps.skillRegistry.list();

      let systemPrompt =
        config.agent?.systemPrompt || "You are a helpful assistant.";

      const model = createModelFromConfig({
        type: config.provider.type,
        model: config.provider.model,
        apiKey: config.provider.apiKey,
        baseUrl: config.provider.baseUrl,
        azureDeployment: config.provider.azureDeployment,
      });

      if (workspaceSkills.length > 0) {
        const actionableSkills = workspaceSkills.filter(isDispatchable);

        if (actionableSkills.length > 0) {
          const scopedRegistry = new SkillRegistry();
          for (const s of actionableSkills) scopedRegistry.register(s);

          tools.execute_skill = createSkillRouterTool(
            scopedRegistry,
            model,
            async (mcpToolFilter) => {
              if (!mcpToolFilter) return {};
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

      const result = await generateText({
        model,
        tools,
        system: systemPrompt,
        prompt: userText,
        stopWhen: stepCountIs(config.agent?.maxSteps ?? 20),
        maxRetries: 0,
      });

      const response: Message = {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: result.text }],
        contextId: requestContext.contextId,
      };
      eventBus.publish(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorResponse: Message = {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: `Error: ${errorMessage}` }],
        contextId: requestContext.contextId,
      };
      eventBus.publish(errorResponse);
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(
    _taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Phase 1: no-op. Cancellation deferred.
  }
}
