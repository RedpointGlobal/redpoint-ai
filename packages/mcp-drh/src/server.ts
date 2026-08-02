import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDatabaseTools } from "./tools/databases.js";
import { registerSourceTools } from "./tools/sources.js";
import { registerFeedTools } from "./tools/feeds.js";
import { registerRunTools } from "./tools/runs.js";
import { registerDataQualityTools } from "./tools/data-qualities.js";
import { registerSubjectAreaTools } from "./tools/subject-areas.js";
import { registerScheduleTools } from "./tools/schedules.js";
import { registerAggsTools } from "./tools/aggs.js";
import { registerAutomationLogTools } from "./tools/automation-logs.js";
import { registerUiDashboardTools } from "./tools/ui-dashboard.js";
import { registerAuthTools } from "./tools/auth.js";
import type { DRHApiClient } from "./client/drh-api.js";

/**
 * DRH MCP server factory. A new instance is created per HTTP session (the SDK
 * Protocol can only `connect()` once per server). Mirrors `createRPIMcpServer`.
 *
 * The real tool surface registers only when a live `client` is present (built
 * from env in http.ts). With no client configured (no DRH credentials) the
 * server exposes no tools — the DR Hub workspace requires credentials.
 */
export function createDrhMcpServer(client?: DRHApiClient) {
  const server = new McpServer({
    name: "drh-mcp-server",
    version: "0.1.0",
  });

  if (client) {
    registerDatabaseTools(server, client);
    registerSourceTools(server, client);
    registerFeedTools(server, client);
    registerRunTools(server, client);
    registerDataQualityTools(server, client);
    registerSubjectAreaTools(server, client);
    registerScheduleTools(server, client);
    registerAggsTools(server, client);
    registerAutomationLogTools(server, client);
    registerUiDashboardTools(server, client);
    registerAuthTools(server, client);

    disableWriteTools(server);
  }

  return { server };
}

// ---------------------------------------------------------------------------
// Write-tool enforcement — unconditional, no env toggle by design. Mirrors
// createRPIMcpServer's gate (see packages/mcp-rpi/src/server.ts for the full
// rationale).
//
// The standalone MCP binaries expose the raw registered surface to any
// authenticated MCP client — no skills, no mcpToolFilter. This sweep disables
// every tool that declares itself a write (annotations.readOnlyHint === false,
// i.e. the MUTATING and DESTRUCTIVE presets in tools/_shared.ts) so it is absent
// from tools/list AND rejected on tools/call by the SDK CallTool handler.
//
// No READ_ONLY env key on purpose — the binaries ship with a working .env reps
// hand-edit, so a toggle would hand the bypass to the population this closes.
// The control is the rebuild, not a flag.
//
// Fail-closed by annotation, NOT a name denylist — any write tool added later is
// gated automatically until explicitly allowed here. To re-enable a write tool,
// add its name to WRITE_TOOLS_ALLOWED and rebuild; the tool stays fully
// registered (schema/handler/description intact), so reversal is one array entry
// + rebuild, doable by us with no DRH-side dependency.
//
// The allowlist is intentionally empty: unlike RPI's count/waterfall, no DRH
// write is a read-shaped rep workflow — the job-starting tools here
// (drh_create_match_run, drh_create_feed_run, drh_create_rpi_sync_run) trigger
// real server-side processing and are correctly gated. If reps need to fire a
// specific run from the binary, add that one tool name here.
const WRITE_TOOLS_ALLOWED: string[] = [];

function disableWriteTools(server: McpServer): void {
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { annotations?: { readOnlyHint?: boolean }; disable: () => void }
      >;
    }
  )._registeredTools;

  const disabled: string[] = [];
  for (const [name, tool] of Object.entries(registered)) {
    if (
      tool.annotations?.readOnlyHint === false &&
      !WRITE_TOOLS_ALLOWED.includes(name)
    ) {
      tool.disable();
      disabled.push(name);
    }
  }

  // console.error (never console.log) — stdout is the stdio MCP transport.
  console.error(
    `[mcp-drh] write-tool enforcement: disabled ${disabled.length} write tool(s)` +
      (disabled.length ? `: ${disabled.sort().join(", ")}` : ""),
  );
}
