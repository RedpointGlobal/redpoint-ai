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
import { normalizeEndpoint } from "./endpoint-path.js";
import { registerGeneratedTools } from "./tools/generated/index.js";
import { initAuthScope } from "./auth-scope.js";

export function createRPIMcpServer(
  rpiConfig: RPIConfig,
  authService: RPIAuthService,
  oidcVerifier?: OidcVerifier | null,
  // The running instance's served endpoint-set (normalized), fetched once at boot.
  // null → fail-open: don't mask, the full compiled-in superset stays registered.
  instanceEndpoints?: Set<string> | null,
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

  // Wire the central per-tool auth-scoping decision (auth-scope.resolveToolAuth,
  // applied by every createToolRegistrar handler) to this instance's proxy-token
  // source. MUST precede tool registration below.
  initAuthScope(authService);

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
  // Generated (spec-derived) read-only tools — #27634. Additive to the 47 above;
  // masked + write-gated by the same sweeps below.
  registerGeneratedTools(server, rpiClient);

  disableWriteTools(server);
  // Mask AFTER the write-gate and BEFORE installToolFilter: installToolFilter
  // snapshots per-category counts at install, so any disable must precede it.
  const maskedCount = disableUnservedTools(server, instanceEndpoints ?? null);
  installToolFilter(server);

  return { server, rpiClient, maskedCount };
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

// ---------------------------------------------------------------------------
// Runtime endpoint mask (#27634) — superset-at-build / mask-at-runtime.
//
// The server ships a curated GET-tool superset compiled in. At boot the host
// fetches the RUNNING instance's OpenAPI spec (fetchInstanceSpec) and passes
// the served, normalized endpoint-set in here; this disables any tool whose
// declared endpoint(s) the instance doesn't serve, so an older/newer instance
// only ever sees tools it can actually satisfy. One artifact fits every instance.
//
// Fail-open: instanceEndpoints === null (spec unreachable) → no-op, full superset
// stays (the caller surfaces maskStatus:"unreachable"). Cheap no-op on an empty
// diff (customer built against their own instance → nothing to hide). A tool with
// no _meta.endpoints is KEPT (can't diff). Shares the ONE normalizer with the
// build-time stamps so both layers agree on what "exists" means.
export function disableUnservedTools(
  server: McpServer,
  instanceEndpoints: Set<string> | null,
): number {
  if (instanceEndpoints === null) return 0;

  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          enabled: boolean;
          _meta?: { endpoints?: string[] };
          disable: () => void;
        }
      >;
    }
  )._registeredTools;

  const disabled: string[] = [];
  for (const [name, tool] of Object.entries(registered)) {
    if (!tool.enabled) continue; // already gated (write-tool sweep) — skip
    const endpoints = tool._meta?.endpoints;
    if (!endpoints || endpoints.length === 0) continue; // no declaration → keep
    const anyServed = endpoints.some((e) =>
      instanceEndpoints.has(normalizeEndpoint(e)),
    );
    if (!anyServed) {
      tool.disable();
      disabled.push(name);
    }
  }

  console.error(
    `[mcp-rpi] endpoint mask: disabled ${disabled.length} tool(s) not served by the instance` +
      (disabled.length ? `: ${disabled.sort().join(", ")}` : ""),
  );
  return disabled.length;
}
