/**
 * A2A server entry point.
 *
 * Dynamic-imported from apps/server/src/index.ts ONLY when A2A_ENABLED=true.
 * This keeps Express and @a2a-js/sdk out of the runtime when A2A is disabled.
 *
 * Configuration via env vars:
 *   - A2A_ENABLED       — "true" to enable
 *   - A2A_AUTH_MODE     — REQUIRED: "oidc" (per-user token: RPI-realm JWT or RPI-validated) or "bearer".
 *                         oidc forwards each caller's token to the workspace's MCP servers, so
 *                         every one must enforce per-user auth (mcp-rpi: AUTH_REQUIRED=true);
 *                         index.ts checks this at boot (checkPerUserMcp) and does not start otherwise.
 *   - A2A_BEARER_TOKEN  — bearer mode: token required on all non-discovery requests
 *   - A2A_WORKSPACE_ID  — which workspace to route A2A requests through
 *   - A2A_PORT          — optional, defaults to 4100
 *
 * Ported from RP-Vercel-Agent v3 (src/a2a/server/index.ts).
 */

import type { SkillRegistry } from "@redpoint-ai/skills";
import { buildAgentCard } from "./agent-card.js";
import { runA2AServer, type RunningServer } from "./server.js";
import type { A2AAuth } from "./auth.js";

const DEFAULT_A2A_PORT = 4100;

export interface StartA2AServerDeps {
  skillRegistry: SkillRegistry;
  workspaceId: string;
  auth: A2AAuth;
  port?: number;
}

export async function startA2AServer(
  deps: StartA2AServerDeps,
): Promise<RunningServer> {
  const port = deps.port ?? DEFAULT_A2A_PORT;
  const agentCard = buildAgentCard({
    skills: deps.skillRegistry.list(),
    baseUrl: `http://localhost:${port}`,
    auth:
      deps.auth.mode === "oidc"
        ? { mode: "oidc", issuer: deps.auth.verifier.config.issuer }
        : { mode: "bearer" },
  });

  return runA2AServer({
    agentCard,
    port,
    auth: deps.auth,
    workspaceId: deps.workspaceId,
    skillRegistry: deps.skillRegistry,
  });
}
