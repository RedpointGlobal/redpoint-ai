import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load the repo's .env — Bun only auto-loads .env from the cwd, which may differ.
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
import { MCP_DRH_VERSION } from "./version.js";
import { localOnly } from "./local-only.js";
import { RateLimiter, peerFloodLimit, userLimit } from "./rate-limit.js";
import { SessionStore, SESSION_LIMITS, ownerOf } from "./session-store.js";
import { ValidationGuard } from "./validation-guard.js";
import { SERVE_MODE } from "./serve-mode.js";
import { setAuditAccount } from "./tool-audit.js";

// PINNABLE settings: a hardened build compiles these in (`bun build --define
// process.env.X=…`), so a deployer can't change its auth. --define replaces only
// LITERAL `process.env.X` reads, so every decision below reads them through this
// view, built from literal reads; with no defines it holds exactly process.env's
// values. (resolveProxyEnabled takes an env object for exactly this.)
const pinnedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_REQUIRED: process.env.AUTH_REQUIRED,
  DRH_PROXY_ENABLED: process.env.DRH_PROXY_ENABLED,
  DRH_DEFAULT_CLIENT_ID: process.env.DRH_DEFAULT_CLIENT_ID,
  DRH_PIN_CLIENT_ID: process.env.DRH_PIN_CLIENT_ID,
};

// Tenant pinning: one container per tenant. OFF unless compiled on (the hardened
// container's --define) or set in the env. When on, only the configured tenant is
// ever sent and a per-call clientId that differs is rejected (DRHApiClient).
const pinClientId = pinnedEnv.DRH_PIN_CLIENT_ID === "true";

// Secure-by-default: auth is required unless AUTH_REQUIRED is explicitly "false"
// (an UNSET value → required).
const authRequired = pinnedEnv.AUTH_REQUIRED !== "false";

// Token mode REQUIRES the tenant pin. DRH can check a caller's token only within one
// tenant (its only authenticated cheap read is tenant-scoped), so an unpinned token
// mode could only check that a token is present: an invented one would open sessions
// and reach the DRH backend on every tool call. Refused before anything starts
// (exit 78: a configuration error). The hardened container compiles both on.
if (authRequired && !pinClientId) {
  console.error(
    "[mcp-drh] REFUSED — token mode (AUTH_REQUIRED on) requires the tenant pin: set DRH_PIN_CLIENT_ID=true " +
      "(with DRH_DEFAULT_CLIENT_ID, the one tenant this server serves), or run AUTH_REQUIRED=false with the " +
      "proxy user (local only). DRH can check a caller's token only within one tenant.",
  );
  process.exit(78);
}

/** Token mode: the server-wide session cap (the per-token cap stays 20). */
const TOKEN_MODE_MAX_SESSIONS = 200;
/** Token mode: the largest request body accepted. */
const TOKEN_MODE_MAX_BODY_BYTES = 4 * 1024 * 1024;

// Env-credential mode: no sign-in (AUTH_REQUIRED=false) and the proxy user on —
// every call runs as that one DRH account, so whoever reaches the server acts as
// it. The server is then LOCAL-ONLY: it binds the loopback interface (no LAN),
// refuses a browser page from another site and a non-loopback Host (./local-only.ts),
// and applies the per-peer flood ceiling (./rate-limit.ts). No setting widens it.
// With a token the token is the gate, and the server keeps every interface.
const envCredentialMode = !authRequired && (() => {
  try {
    return resolveProxyEnabled(pinnedEnv);
  } catch {
    return false;
  }
})();
const LOOPBACK_BIND = "127.0.0.1";

// Boot-time config detection. Without it an unconfigured DRH looks identical to
// an unreachable one from the outside, and a caller cannot tell "nobody set this
// up" from "the server is down" — the two need different answers.
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
// Both proxy decisions read the pinned view: the hardened build compiles the proxy
// off, so account credentials in its environment are never loaded.
try {
  if (resolveProxyEnabled(pinnedEnv)) {
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
  drhConfig = loadDrhConfigFromEnv(pinnedEnv);
} catch (err) {
  console.error(
    `[mcp-drh] configuration rejected: ${err instanceof Error ? err.message : String(err)}`,
  );
}
let client: DRHApiClient | undefined;
let drhAuth: DRHAuthService | undefined;
if (drhConfig) {
  const auth = (drhAuth = new DRHAuthService(
    drhConfig.apiUrl,
    drhConfig.proxyUser,
    drhConfig.proxyPass,
    drhConfig.tokenTtlSeconds,
  ));
  client = new DRHApiClient(
    drhConfig.apiUrl,
    auth,
    drhConfig.defaultClientId,
    drhConfig.defaultDatabaseId,
    pinClientId,
  );
  // The native account a token-less call runs as, for the audit principal
  // (drh-native:<user>). Null when the proxy is off (token mode): then a
  // token-less call is anonymous.
  setAuditAccount(drhConfig.proxyEnabled ? drhConfig.proxyUser : null);
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

// Env-credential mode is local-only: every call runs as one DRH account, so the
// server answers clients on THIS machine only. Mounted BEFORE CORS so a foreign
// page's preflight is refused too (./local-only.ts). The per-peer flood ceiling
// (./rate-limit.ts) applies in every mode; token mode adds the token check's
// budgets (./validation-guard.ts) and the per-user request budget (on /mcp). The
// loopback bind is at the export below.
const limiter = new RateLimiter();
if (envCredentialMode) app.use("/*", localOnly());
app.use("/*", peerFloodLimit(limiter));

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

// /health carries `mcp: "degraded"` plus the reason and the variable names when
// the backend isn't configured. `missing` is for logs — a UI should surface the
// first name, not the internals.
app.get("/health", (c) =>
  c.json(
    drhDegraded
      ? {
          status: "ok",
          server: "drh-mcp-server",
          serverVersion: MCP_DRH_VERSION,
          transport: "http",
          mcp: "degraded",
          reason: "drh_unconfigured",
          missing: missingDrhVars,
        }
      : { status: "ok", server: "drh-mcp-server", serverVersion: MCP_DRH_VERSION, transport: "http" },
  ),
);

// Incoming-auth: ON by default (AUTH_REQUIRED !== "false"), so an unauth'd request
// can't ride the service-account proxy token. Token mode is pinned (refused above
// otherwise), so the caller's token is checked against DRH for the one tenant,
// budgeted and cached; until the backend is configured only its presence is checked
// (no tools are served then).
const authMw = createDrhAuthMiddleware(
  authRequired,
  authRequired && drhAuth && drhConfig
    ? { auth: drhAuth, tenant: drhConfig.defaultClientId, budgets: new ValidationGuard() }
    : null,
);
// After auth, token mode: each caller's request budget (keyed on the token).
const perUser = authRequired ? [userLimit(limiter, (c) => c.get("callerKey") ?? "anonymous")] : [];

// Sessions live in the owner-bound, idle-expiring, capped registry
// (./session-store.ts). A session belongs to the caller that created it (a hash
// of its token; "anonymous" when auth is off), so an unknown, foreign or expired
// id all look the same — one 404 — and ids can't be probed. Token mode caps the
// whole server at TOKEN_MODE_MAX_SESSIONS (each token at 20; DRH tokens are opaque,
// so the token is the user).
const sessions = new SessionStore<WebStandardStreamableHTTPServerTransport>(
  authRequired ? { ...SESSION_LIMITS, maxSessions: TOKEN_MODE_MAX_SESSIONS } : SESSION_LIMITS,
);
setInterval(() => sessions.sweep(), 60_000).unref?.();

/** The ONE answer for a session id that is unknown, someone else's, or expired. */
const SESSION_NOT_FOUND = { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null } as const;

app.all("/mcp", authMw, ...perUser, async (c) => {
  const sessionId = c.req.header("mcp-session-id");
  const authInfo = c.get("authInfo");
  const owner = ownerOf(authInfo?.token);

  // An unknown, foreign or expired session id: ONE identical 404.
  if (sessionId) {
    const existing = sessions.get(sessionId, owner);
    return existing ? existing.handleRequest(c.req.raw, { authInfo }) : c.json(SESSION_NOT_FOUND, 404);
  }

  // A new session: reserve its slot first, so concurrent initializes can't overshoot a cap.
  const slot = sessions.reserve(owner);
  if (!slot.ok) return c.json({ error: slot.message }, slot.status);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      slot.commit(id, transport);
      console.error(`Session initialized: ${id}`);
    },
    onsessionclosed: (id) => {
      sessions.remove(id);
      console.error(`Session closed: ${id}`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.remove(transport.sessionId);
  };

  try {
    const { server } = createDrhMcpServer(client);
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw, { authInfo });
  } finally {
    // Not an initialize (or it failed): no session came of the slot.
    slot.release();
  }
});

const port = Number(process.env.DRH_MCP_HTTP_PORT) || 3003;

// Env-credential mode listens on the IPv6 loopback too: Windows resolves
// "localhost" to ::1 first, and a client without happy eyeballs waits ~2s on every
// connection for the refused ::1 before falling back to 127.0.0.1. Where ::1 doesn't
// exist (a container with IPv6 off), the IPv4 loopback alone serves.
let ipv6Loopback = false;
if (envCredentialMode) {
  try {
    Bun.serve({ port, hostname: "::1", idleTimeout: 255, ...SERVE_MODE, fetch: app.fetch });
    ipv6Loopback = true;
  } catch {
    /* no IPv6 loopback here — the IPv4 bind below serves */
  }
}

console.error(
  envCredentialMode
    ? `DR Hub MCP Server ${MCP_DRH_VERSION} (HTTP) starting on ${LOOPBACK_BIND}:${port}${ipv6Loopback ? ` and [::1]:${port}` : ""} — local only (every call runs as one DRH account: this machine's clients only, no LAN, no web pages from other sites)`
    : `DR Hub MCP Server ${MCP_DRH_VERSION} (HTTP) starting on port ${port} (all interfaces)`,
);
console.error(`Auth required: ${authRequired}`);

export default {
  port,
  ...(envCredentialMode ? { hostname: LOOPBACK_BIND } : {}),
  // Token mode: a request body over TOKEN_MODE_MAX_BODY_BYTES is refused (413)
  // before it is read; no MCP request comes near it.
  ...(authRequired ? { maxRequestBodySize: TOKEN_MODE_MAX_BODY_BYTES } : {}),
  idleTimeout: 255,
  // Production mode and an unshared port, whatever NODE_ENV says (./serve-mode.ts).
  ...SERVE_MODE,
  fetch: app.fetch,
};
