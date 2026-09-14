import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load root .env for the monorepo — Bun only auto-loads .env from cwd, which is
// packages/mcp-drh/ when run via the workspace filter. Mirrors mcp-rpi so that
// AUTH_REQUIRED and the DRH_* vars are visible under `bun run dev`.
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
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createDrhMcpServer } from "./server.js";
import { loadDrhConfigFromEnv, resolveProxyEnabled } from "./config.js";
import { DRHAuthService } from "./client/drh-auth.js";
import { DRHApiClient } from "./client/drh-api.js";
import { createDrhAuthMiddleware } from "./middleware/auth.js";

const authRequired = process.env.AUTH_REQUIRED !== "false";

// Boot-time config detection, mirroring mcp-rpi's missingRpiVars. Without it
// an unconfigured DRH looks identical to an unreachable one from the outside,
// and the orchestrator cannot tell "nobody set this up" from "the server is
// down" — the two need different answers on a workspace card.
//
// The required set is DERIVED FROM THE CONFIG CONTRACT, not invented here:
//   - DRH_DEFAULT_DATABASE_ID is excluded — config.ts declares it `.optional()`
//     and maps an absent value to undefined. It is an injected default for
//     database-scoped calls, not a precondition; tools work without it.
//   - the proxy credentials are required ONLY when the proxy is enabled, which
//     is exactly what config.ts's `.refine()` enforces. Listing them
//     unconditionally would report "DRH_PROXY_USER is not set" about a variable
//     an operator deliberately left unset — the diagnostic lying, which is the
//     failure this reporting exists to prevent.
const missingDrhVars: string[] = [];
if (!process.env.DRH_API_URL) missingDrhVars.push("DRH_API_URL");
if (!process.env.DRH_DEFAULT_CLIENT_ID) missingDrhVars.push("DRH_DEFAULT_CLIENT_ID");
// resolveProxyEnabled() THROWS on the contradictory case (DRH_PROXY_ENABLED=true
// with no creds). Catch it: that throw is itself the signal, and crashing here
// would defeat the point — a dead container reports as "unreachable", which is a
// worse diagnostic than naming the variable that is actually missing.
try {
  if (resolveProxyEnabled()) {
    if (!process.env.DRH_PROXY_USER) missingDrhVars.push("DRH_PROXY_USER");
    if (!process.env.DRH_PROXY_PASS) missingDrhVars.push("DRH_PROXY_PASS");
  }
} catch {
  if (!process.env.DRH_PROXY_USER) missingDrhVars.push("DRH_PROXY_USER");
  if (!process.env.DRH_PROXY_PASS) missingDrhVars.push("DRH_PROXY_PASS");
}
const drhDegraded = missingDrhVars.length > 0;
if (drhDegraded) {
  console.error(
    `[mcp-drh] DEGRADED MODE — DRH configuration missing: ${missingDrhVars.join(", ")}. ` +
      `Server remains up; DRH tool registration is skipped. ` +
      `Set the missing env vars and restart to enable DRH tools.`,
  );
}

// Build the DRH API client when the backend is configured. When it isn't (no
// DRH_API_URL / DRH_DEFAULT_CLIENT_ID) the server boots but exposes NO tools —
// the DR Hub workspace requires credentials. Backend/permission failures on a
// live call surface as clean error envelopes (the degraded behavior).
// Same reason: the loader calls resolveProxyEnabled() unguarded, so a
// contradictory proxy config used to take the whole container down at boot.
// Degrade instead — /health then explains why rather than going silent.
let drhConfig: ReturnType<typeof loadDrhConfigFromEnv> = null;
try {
  drhConfig = loadDrhConfigFromEnv();
} catch (err) {
  console.error(
    `[mcp-drh] configuration rejected: ${err instanceof Error ? err.message : String(err)}`,
  );
}
let client: DRHApiClient | undefined;
if (drhConfig) {
  const auth = new DRHAuthService(
    drhConfig.apiUrl,
    drhConfig.proxyUser,
    drhConfig.proxyPass,
    drhConfig.tokenTtlSeconds,
  );
  client = new DRHApiClient(
    drhConfig.apiUrl,
    auth,
    drhConfig.defaultClientId,
    drhConfig.defaultDatabaseId,
  );
} else {
  // drhConfig is null for TWO distinct reasons — do not conflate them: either the
  // required vars are unset (loadDrhConfigFromEnv returned null) OR they are set
  // but a value is invalid (it THREW, already logged "configuration rejected"
  // above — e.g. a non-numeric DRH_DEFAULT_DATABASE_ID → NaN). The old message
  // hardcoded "DRH_API_URL / DRH_DEFAULT_CLIENT_ID unset", which lied whenever the
  // real cause was an invalid value. Report the actual reason.
  const why = missingDrhVars.length
    ? `missing: ${missingDrhVars.join(", ")}`
    : "the DRH_* vars are set but a value is invalid — see the 'configuration rejected' error above";
  console.error(
    `[mcp-drh] DRH backend not configured (${why}) — no tools exposed. ` +
      "Set/fix the DRH_* vars to enable the live client.",
  );
}

const app = new Hono();
// CORS origin allowlist — never wildcard. DRH_CORS_ORIGINS is a comma-separated
// list of allowed origins; defaults to the local dev origins so same-machine dev
// works. Set it explicitly to the deployment's web origin(s) for a cross-origin /
// split deploy.
const corsOrigins = (
  process.env.DRH_CORS_ORIGINS || "http://localhost:3000,http://localhost:3001"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use("/*", cors({ origin: corsOrigins }));

// Same shape as mcp-rpi's /health so a caller can read either server's state
// without per-product branching: `mcp: "degraded"` plus the reason and the
// variable names. `missing` is for logs — a UI should surface the first name,
// not the internals.
app.get("/health", (c) =>
  c.json(
    drhDegraded
      ? {
          status: "ok",
          server: "drh-mcp-server",
          transport: "http",
          mcp: "degraded",
          reason: "drh_unconfigured",
          missing: missingDrhVars,
        }
      : { status: "ok", server: "drh-mcp-server", transport: "http" },
  ),
);

// Incoming-auth: ON by default (AUTH_REQUIRED !== "false"). Presence-gates the
// caller's bearer token so an unauth'd request can't ride the service-account
// proxy token.
const authMw = createDrhAuthMiddleware(authRequired);
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

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
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  const { server } = createDrhMcpServer(client);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw, { authInfo });
});

const port = Number(process.env.DRH_MCP_HTTP_PORT) || 3003;

console.error(`DR Hub MCP Server (HTTP) starting on port ${port}`);
console.error(`Auth required: ${authRequired}`);

export default {
  port,
  idleTimeout: 255,
  fetch: app.fetch,
};
