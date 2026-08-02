import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "./client/rpi-api.js";
import type { RPIAuthService } from "./client/rpi-auth.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerClientTools } from "./tools/clients.js";
import { registerFileSystemTools } from "./tools/file-system.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerInteractionTools } from "./tools/interactions.js";
import { registerSelectionRuleTools } from "./tools/selection-rules.js";
import type { OidcVerifier } from "./client/oidc-discovery.js";
import type { RPIConfig } from "./config.js";
import { installToolFilter } from "./tool-filter.js";

export function createRPIMcpServer(
  rpiConfig: RPIConfig,
  authService: RPIAuthService,
  oidcVerifier?: OidcVerifier | null,
) {
  const server = new McpServer({
    name: "rpi-mcp-server",
    version: "0.1.0",
  });

  const rpiClient = new RPIApiClient(
    rpiConfig.integrationApiUrl,
    authService,
    rpiConfig.defaultClientId,
  );

  // Register all tool domains rewritten against real RPI API paths.
  // Fictional-path domains (campaigns, content, profiles, channels, reporting,
  // realtime) were deleted; rebuild them on demand against verified endpoints.
  registerAudienceTools(server, rpiClient);
  registerAdminTools(server, rpiClient);
  registerAuthTools(server, rpiClient, authService, oidcVerifier);
  registerClientTools(server, rpiClient);
  registerFileSystemTools(server, rpiClient);
  registerFolderTools(server, rpiClient);
  registerInteractionTools(server, rpiClient);
  registerSelectionRuleTools(server, rpiClient);

  disableWriteTools(server);
  installToolFilter(server);

  return { server, rpiClient };
}

// ---------------------------------------------------------------------------
// Write-tool enforcement — unconditional, no env toggle by design.
//
// The standalone MCP binaries expose the raw registered tool surface to any
// authenticated MCP client: no skills, no mcpToolFilter, so the orchestrator's
// read-only posture is bypassed entirely and an authenticated caller can invoke
// any registered tool. This sweep disables every tool that declares itself a
// write (annotations.readOnlyHint === false) so it is absent from tools/list AND
// rejected on tools/call by the SDK's CallTool handler
// (`if (!tool.enabled) throw McpError(InvalidParams, "Tool X disabled")`).
//
// No READ_ONLY env key on purpose: the binaries ship with a working .env that
// reps already hand-edit, so a toggle would hand the bypass to exactly the
// population this closes. The control is the rebuild, not a flag.
//
// Fail-closed by annotation, NOT a name denylist — any write tool added later is
// gated automatically until explicitly allowed here. To re-enable a write tool,
// add its name to WRITE_TOOLS_ALLOWED and rebuild. No RPI-side knowledge needed:
// the tool stays fully registered (schema/handler/description intact); this only
// ungates it. That reversal is one array entry + rebuild — doable by us, no
// API-side question, no dependency on the RPI team.
//
// ACCEPTED RISK (not verified-safe): run_selection_rule_count / _waterfall DO
// start server-side jobs (POST /client/jobs/start/…); their RPI-internal effects
// aren't visible from this repo. They are kept because count/waterfall are a core
// rep workflow — accepted risk pending an SME verdict, NOT cleared.
const WRITE_TOOLS_ALLOWED = [
  "run_selection_rule_count",
  "run_selection_rule_waterfall",
];

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
    `[mcp-rpi] write-tool enforcement: disabled ${disabled.length} write tool(s)` +
      (disabled.length ? `: ${disabled.sort().join(", ")}` : ""),
  );
}
