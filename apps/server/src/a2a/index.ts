/**
 * A2A server entry point.
 *
 * Dynamic-imported from apps/server/src/index.ts ONLY when A2A_ENABLED=true.
 * This keeps Express and @a2a-js/sdk out of the runtime when A2A is disabled.
 *
 * Configuration via env vars:
 *   - A2A_ENABLED       — "true" to enable
 *   - A2A_BEARER_TOKEN  — token required on all non-discovery requests
 *   - A2A_WORKSPACE_ID  — which workspace to route A2A requests through
 *   - A2A_PORT          — optional, defaults to 4100
 *
 * Ported from RP-Vercel-Agent v3 (src/a2a/server/index.ts).
 */

import type { SkillRegistry } from "@redpoint-ai/skills";
import { buildAgentCard } from "./agent-card.js";
import { runA2AServer, type RunningServer } from "./server.js";

const DEFAULT_A2A_PORT = 4100;

export interface StartA2AServerDeps {
  skillRegistry: SkillRegistry;
  workspaceId: string;
  bearerToken: string;
  port?: number;
}

export async function startA2AServer(
  deps: StartA2AServerDeps,
): Promise<RunningServer> {
  const port = deps.port ?? DEFAULT_A2A_PORT;
  const agentCard = buildAgentCard({
    skills: deps.skillRegistry.list(),
    baseUrl: `http://localhost:${port}`,
  });

  return runA2AServer({
    agentCard,
    port,
    bearerToken: deps.bearerToken,
    workspaceId: deps.workspaceId,
    skillRegistry: deps.skillRegistry,
  });
}
