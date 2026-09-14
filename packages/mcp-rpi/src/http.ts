import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load root .env for monorepo — Bun only auto-loads .env from cwd,
// which is packages/mcp-rpi/ when run via workspace filter.
const __mcpDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(__mcpDir, "../../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf("#");
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRPIMcpServer } from "./server.js";
import { fetchInstanceSpec } from "./client/spec-fetch.js";
import { compareVersion, BUILT_AGAINST_API_VERSION, type VersionStatus } from "./client/version-check.js";
import { RPIConfigSchema, resolveProxyEnabled } from "./config.js";
import { RPIAuthService } from "./client/rpi-auth.js";
import { createRpiAuthMiddleware } from "./middleware/auth.js";
import { buildProtectedResourceMetadata } from "./oauth-metadata.js";
import { discoverOidcConfig, createOidcVerifier } from "./client/oidc-discovery.js";
import type { OidcVerifier } from "./client/oidc-discovery.js";

// Detect missing RPI env vars. Any missing → DEGRADED mode: HTTP listener
// stays up so /health responds and the docker container does not enter a
// restart loop, but RPI tool registration is skipped. Operator sees a
// single boot warning (NOT per-request) naming the missing vars; /health
// surfaces degraded state; /mcp returns a structured error so MCP clients
// fail fast instead of hanging.
const missingRpiVars: string[] = [];
if (!process.env.RPI_INTEGRATION_API_URL) missingRpiVars.push("RPI_INTEGRATION_API_URL");
if (!process.env.RPI_OAUTH_CLIENT_ID) missingRpiVars.push("RPI_OAUTH_CLIENT_ID");
if (!process.env.RPI_OAUTH_CLIENT_SECRET) missingRpiVars.push("RPI_OAUTH_CLIENT_SECRET");
if (!process.env.RPI_DEFAULT_CLIENT_ID) missingRpiVars.push("RPI_DEFAULT_CLIENT_ID");

// Secure-by-default: auth is required unless AUTH_REQUIRED is explicitly "false"
// (an UNSET value → required). Matches apps/server's gate + boot guard.
const authRequired = process.env.AUTH_REQUIRED !== "false";

interface NormalSetup {
  degraded: false;
  config: ReturnType<typeof RPIConfigSchema.parse>;
  authService: RPIAuthService;
  oidcVerifier: OidcVerifier | null;
  // Discovered OIDC issuer (the authorization server advertised in the RFC 9728
  // Protected Resource Metadata for MCP OAuth clients). null when no OpenID
  // provider is configured → discovery endpoints 404.
  oidcIssuer: string | null;
  // #27634 runtime mask. instanceEndpoints = the running instance's served,
  // normalized endpoint-set (null = spec unreachable → fail-open, no mask).
  // maskStatus is the operator-visible health (a SOFT note — never DegradedSetup,
  // which 503s /mcp); maskedCount is filled on the first session's factory call.
  instanceEndpoints: Set<string> | null;
  maskStatus: "applied" | "unreachable";
  maskedCount: number | null;
  // Coarse MAJOR.MINOR version gate (from the same swagger fetch's info.version).
  // A SOFT note like maskStatus — "mismatch" warns but never 503s / never degrades.
  // "unknown" = version absent/unparseable (fail-open). instanceVersion is the raw
  // string for the diagnostic.
  versionStatus: VersionStatus;
  instanceVersion: string | null;
}
interface DegradedSetup {
  degraded: true;
  reason: string;
  missing: string[];
}

// Definite-assignment: every branch below assigns `setup` (the try/catch +
// error-suppression flow defeats TS's control-flow analysis, but it IS always set).
let setup!: NormalSetup | DegradedSetup;

if (missingRpiVars.length > 0) {
  console.error(
    `[mcp-rpi] DEGRADED MODE — RPI credentials missing: ${missingRpiVars.join(", ")}. ` +
      `Server + web remain functional; RPI tool registration is skipped. ` +
      `Set the missing env vars and restart to enable RPI tools.`,
  );
  setup = { degraded: true, reason: "rpi_unconfigured", missing: missingRpiVars };
} else {
  let proxyEnabled: boolean;
  try {
    proxyEnabled = resolveProxyEnabled();
  } catch (err) {
    console.error(
      `[mcp-rpi] DEGRADED MODE — proxy config invalid: ${(err as Error).message}. ` +
        `Server + web remain functional; RPI tool registration is skipped.`,
    );
    setup = { degraded: true, reason: "proxy_config_invalid", missing: [] };
  }
  // @ts-expect-error -- TS narrows `proxyEnabled` to never if the catch ran;
  // we know the catch assigns to `setup` and falls through to the if below.
  if (typeof proxyEnabled === "boolean") {
    const config = RPIConfigSchema.parse({
      integrationApiUrl: process.env.RPI_INTEGRATION_API_URL,
      proxyEnabled,
      proxyUser: proxyEnabled ? process.env.RPI_PROXY_USER : undefined,
      proxyPass: proxyEnabled ? process.env.RPI_PROXY_PASS : undefined,
      oauthClientId: process.env.RPI_OAUTH_CLIENT_ID,
      oauthClientSecret: process.env.RPI_OAUTH_CLIENT_SECRET,
      defaultClientId: process.env.RPI_DEFAULT_CLIENT_ID,
      authRequired,
    });
    const authService = new RPIAuthService(
      config.integrationApiUrl,
      config.oauthClientId,
      config.oauthClientSecret,
      config.proxyUser,
      config.proxyPass,
    );
    let oidcVerifier: OidcVerifier | null = null;
    let oidcIssuer: string | null = null;
    if (authRequired) {
      const oidcConfig = await discoverOidcConfig(authService);
      if (oidcConfig) {
        oidcVerifier = createOidcVerifier(oidcConfig);
        oidcIssuer = oidcConfig.issuer;
        console.error(`OIDC verification enabled (issuer: ${oidcConfig.issuer})`);
      } else {
        console.error(
          "OIDC not detected — using validateTokenStatus for all token verification",
        );
      }
    }
    // #27634: fetch the instance's OpenAPI spec ONCE at boot. From that single
    // fetch we derive BOTH the endpoint mask AND the coarse version gate. Fail-open
    // — each signal is independently null on error; tools stay up regardless (soft
    // maskStatus/versionStatus, NOT DegradedSetup).
    const spec = await fetchInstanceSpec(config.integrationApiUrl);
    const instanceEndpoints = spec.endpoints;
    const maskStatus = instanceEndpoints ? "applied" : "unreachable";
    console.error(
      instanceEndpoints
        ? `[mcp-rpi] endpoint mask: instance spec loaded (${instanceEndpoints.size} served paths)`
        : `[mcp-rpi] endpoint mask: instance spec unreachable — failing open (full tool superset)`,
    );
    // Coarse MAJOR.MINOR version gate from the same swagger's info.version. Mismatch
    // WARNS (the tool surface may drift) but never blocks boot — consistent with the
    // fail-open mask and the same-version support boundary.
    const versionStatus = compareVersion(spec.version);
    if (versionStatus === "mismatch") {
      console.warn(
        `[mcp-rpi] API version mismatch: instance ${spec.version} vs built-against ${BUILT_AGAINST_API_VERSION}.x — tool surface may drift; failing open. Same-version instances only are supported on one server.`,
      );
    } else {
      console.error(
        `[mcp-rpi] API version: instance ${spec.version ?? "unknown"} (${versionStatus} vs built-against ${BUILT_AGAINST_API_VERSION}.x)`,
      );
    }
    setup = {
      degraded: false,
      config,
      authService,
      oidcVerifier,
      oidcIssuer,
      instanceEndpoints,
      maskStatus,
      maskedCount: null,
      versionStatus,
      instanceVersion: spec.version,
    };
  }
}

const app = new Hono();
// Permissive CORS + CRITICAL: expose WWW-Authenticate so browser MCP clients
// (e.g. claude.ai) can read the OAuth challenge off a 401 — without exposing it
// cross-origin, spec-correct discovery silently fails (the #1 browser gotcha).
// hono/cors also answers the OPTIONS preflight. Bearer-in-header auth needs no
// credentials, so `origin: "*"` is correct here.
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS", "DELETE"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "mcp-session-id",
      "mcp-protocol-version",
    ],
    exposeHeaders: ["WWW-Authenticate", "mcp-session-id"],
  }),
);

app.get("/health", (c) =>
  c.json(
    setup.degraded
      ? {
          status: "ok",
          server: "rpi-mcp-server",
          transport: "http",
          mcp: "degraded",
          reason: setup.reason,
          missing: setup.missing,
        }
      : {
          status: "ok",
          server: "rpi-mcp-server",
          transport: "http",
          mask: { status: setup.maskStatus, maskedCount: setup.maskedCount },
          version: {
            status: setup.versionStatus,
            instance: setup.instanceVersion,
            builtAgainst: BUILT_AGAINST_API_VERSION,
          },
        },
  ),
);

// The authorization server for MCP OAuth discovery (Mechanism A) — the OIDC
// issuer discovered at boot. null in degraded mode or when no OpenID provider
// is configured, which makes the discovery endpoints 404 (no AS to advertise).
const oidcIssuer = setup.degraded ? null : setup.oidcIssuer;

// RFC 9728 Protected Resource Metadata — served UNAUTHENTICATED so an external
// MCP client hitting a 401 can discover the authorization server. Path-inserted
// for the /mcp resource (§3.1) plus the root path. Only real when an OIDC
// provider was discovered; otherwise 404 (auth=false / static-Bearer / no OIDC
// are unaffected). SOFT-AUD by design — see oauth-metadata.ts.
const servePrm = (c: Context) => {
  if (!oidcIssuer) {
    return c.json({ error: "OAuth protected-resource metadata not available" }, 404);
  }
  return c.json(buildProtectedResourceMetadata(c.req, oidcIssuer));
};
app.get("/.well-known/oauth-protected-resource", servePrm);
app.get("/.well-known/oauth-protected-resource/mcp", servePrm);

if (setup.degraded) {
  // Degraded /mcp: every request gets a structured JSON-RPC error with HTTP
  // 503 so MCP clients fail fast and don't hang on tool-call attempts. The
  // boot warning above logged the cause once; we DO NOT log per-request to
  // keep `docker compose logs mcp-rpi` quiet after startup.
  app.all("/mcp", (c) =>
    c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message:
            "MCP server is running in degraded mode — RPI is not configured. Set the missing env vars and restart to enable tools.",
          data: { reason: setup.reason, missing: setup.missing },
        },
      },
      503,
    ),
  );
} else {
  // Normal mode: full RPI tool surface. Map of session ID -> transport for
  // stateful sessions. One McpServer instance is created per new session
  // inside the handler (see Issue 3 in the 2026-04-20 session journal):
  // the MCP SDK's Protocol can only `connect()` once per server, so a
  // module-level singleton would 500 on every subsequent session. Shared
  // `authService` (proxy token cache) and `oidcVerifier` are reused.
  const transports = new Map<
    string,
    WebStandardStreamableHTTPServerTransport
  >();
  const { config, authService, oidcVerifier, instanceEndpoints } = setup;
  // Pass oauthDiscoveryEnabled so 401s carry the WWW-Authenticate → PRM
  // challenge exactly when we serve discovery (an OIDC issuer was found).
  const authMw = createRpiAuthMiddleware(
    authService,
    authRequired,
    oidcVerifier,
    !!oidcIssuer,
  );

  app.all("/mcp", authMw, async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    const authInfo = c.get("authInfo");

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      return transport.handleRequest(c.req.raw, { authInfo });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        console.error(`Session initialized: ${id}`);
      },
      onsessionclosed: (id) => {
        transports.delete(id);
        console.error(`Session closed: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const { server, maskedCount } = createRPIMcpServer(
      config,
      authService,
      oidcVerifier,
      instanceEndpoints,
    );
    if (!setup.degraded) setup.maskedCount = maskedCount;
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { authInfo });
  });
}

const port = Number(process.env.RPI_MCP_HTTP_PORT) || 3002;

// IMPORTANT: use console.error, never console.log (breaks stdio protocol in other contexts)
console.error(`RPI MCP Server (HTTP) starting on port ${port}`);
console.error(`Auth required: ${authRequired}`);
if (setup.degraded) {
  console.error(`MCP mode: DEGRADED (reason: ${setup.reason})`);
}

// TIMEOUT INVARIANT (do not break): tool poll budget < apps/server MCP
// client abort < this Bun.serve idleTimeout. Currently:
//   selection-rules DEFAULT_TIMEOUT_SECONDS 220s
//   < apps/server patched-transport DEFAULT_TIMEOUT_MS 240s
//   < idleTimeout 255s (Bun's hard ceiling).
// Bun caps idleTimeout at 255s — it is the LOWEST ceiling, which is why the
// tool budget is forced down to 220 (NOT raised to 300 "to match Java
// RPI-MCPServer"; that would silently re-break long-poll tools by letting
// the transport idle-kill the MCP session mid-poll).
export default {
  port,
  idleTimeout: 255,
  fetch: app.fetch,
};
