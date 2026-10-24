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
import type { Context } from "hono";
import { cors } from "hono/cors";
import { localOnly } from "./local-only.js";
import { setAuditAccount, setAuditTenant } from "./tool-audit.js";
import { tenantPinned } from "./tenant-pin.js";
import { RateLimiter, peerFloodLimit, userLimit } from "./rate-limit.js";
import { ValidationGuard } from "./validation-guard.js";
import { UserSessions } from "./user-sessions.js";
import { SERVE_MODE } from "./serve-mode.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRPIMcpServer } from "./server.js";
import { fetchInstanceSpec } from "./client/spec-fetch.js";
import { compareVersion, BUILT_AGAINST_API_VERSION, type VersionStatus } from "./client/version-check.js";
import { MCP_RPI_VERSION } from "./version.js";
import { RPIConfigSchema, RPILoginOnlyConfigSchema, resolveProxyEnabled, isLoginOnly, missingRpiVarsIn, proxyOnlyBanner } from "./config.js";
import { RPIAuthService, type ProxyLoginStatus } from "./client/rpi-auth.js";
import { createRpiAuthMiddleware } from "./middleware/auth.js";
import { buildProtectedResourceMetadata } from "./oauth-metadata.js";
import { discoverOidcConfig, createOidcVerifier } from "./client/oidc-discovery.js";
import { SessionStore, SESSION_LIMITS, ownerOf } from "./session-store.js";

/** Token mode: the server-wide session cap (the per-token and per-user caps stay 20). */
const TOKEN_MODE_MAX_SESSIONS = 200;
/** Token mode: the largest request body accepted. */
const TOKEN_MODE_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The ONE answer for a session id that is unknown, someone else's, or expired. */
const SESSION_NOT_FOUND = { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null } as const;
import type { OidcVerifier } from "./client/oidc-discovery.js";

// Detect missing RPI env vars. Any missing → DEGRADED mode: HTTP listener
// stays up so /health responds and the docker container does not enter a
// restart loop, but RPI tool registration is skipped. Operator sees a
// single boot warning (NOT per-request) naming the missing vars; /health
// surfaces degraded state; /mcp returns a structured error so MCP clients
// fail fast instead of hanging.
// Login-only mode (AUTH_REQUIRED=true, proxy off) does not require the RPI OAuth
// client (see config.ts).
//
// PINNABLE settings: a build may compile these in (`bun build --define
// process.env.X=…`, so a deployer can't edit its auth: the hardened-pinned container
// does). --define replaces only LITERAL `process.env.X` reads, so every
// decision below reads them through this view, built from literal reads; with
// no defines it holds exactly process.env's values.
const pinnedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_REQUIRED: process.env.AUTH_REQUIRED,
  RPI_PROXY_ENABLED: process.env.RPI_PROXY_ENABLED,
  RPI_OAUTH_CLIENT_ID: process.env.RPI_OAUTH_CLIENT_ID,
  RPI_OAUTH_CLIENT_SECRET: process.env.RPI_OAUTH_CLIENT_SECRET,
  RPI_DEFAULT_CLIENT_ID: process.env.RPI_DEFAULT_CLIENT_ID,
  RPI_URL_ALLOWLIST: process.env.RPI_URL_ALLOWLIST,
  RPI_PIN_CLIENT_ID: process.env.RPI_PIN_CLIENT_ID,
};
const missingRpiVars = missingRpiVarsIn(pinnedEnv);
const loginOnly = isLoginOnly(pinnedEnv);

// Secure-by-default: auth is required unless AUTH_REQUIRED is explicitly "false"
// (an UNSET value → required).
const authRequired = process.env.AUTH_REQUIRED !== "false";

// Env-credential mode: no sign-in (AUTH_REQUIRED=false) and the proxy user on —
// every call runs as that one RPI account, so whoever reaches the server acts as it.
// The server is then LOCAL-ONLY: it binds the loopback interface (no LAN), refuses
// a browser page from another site and a non-loopback Host (./local-only.ts), and
// applies the per-peer flood ceiling (./rate-limit.ts; no per-user budget: one
// account, local clients only). No setting widens it. With a token the token is
// the gate, and the server keeps every interface (a container, a deployment).
const envCredentialMode = !authRequired && (() => {
  try {
    return resolveProxyEnabled(pinnedEnv);
  } catch {
    return false;
  }
})();
const LOOPBACK_BIND = "127.0.0.1";

interface NormalSetup {
  degraded: false;
  config: ReturnType<typeof RPIConfigSchema.parse> | ReturnType<typeof RPILoginOnlyConfigSchema.parse>;
  authService: RPIAuthService;
  oidcVerifier: OidcVerifier | null;
  // Discovered OIDC issuer (the authorization server advertised in the RFC 9728
  // Protected Resource Metadata for MCP OAuth clients). null when no OpenID
  // provider is configured → discovery endpoints 404.
  oidcIssuer: string | null;
  // Runtime mask. instanceEndpoints = the running instance's served,
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
  // The proxy user's login, tried once at boot (null when the proxy is off).
  proxyLogin: ProxyLoginStatus | null;
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
    proxyEnabled = resolveProxyEnabled(pinnedEnv);
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
    // Login-only without the OAuth client: say so once — a native password login
    // is unavailable (named error at use), every call runs on the caller's token.
    if (loginOnly && (!process.env.RPI_OAUTH_CLIENT_ID || !process.env.RPI_OAUTH_CLIENT_SECRET)) {
      console.error(
        "[mcp-rpi] login-only mode (AUTH_REQUIRED=true, proxy off): RPI_OAUTH_CLIENT_ID / RPI_OAUTH_CLIENT_SECRET not set — every call runs on the caller's own token; native password login is unavailable.",
      );
    }
    const config = (loginOnly ? RPILoginOnlyConfigSchema : RPIConfigSchema).parse({
      integrationApiUrl: process.env.RPI_INTEGRATION_API_URL,
      proxyEnabled,
      proxyUser: proxyEnabled ? process.env.RPI_PROXY_USER : undefined,
      proxyPass: proxyEnabled ? process.env.RPI_PROXY_PASS : undefined,
      oauthClientId: process.env.RPI_OAUTH_CLIENT_ID,
      oauthClientSecret: process.env.RPI_OAUTH_CLIENT_SECRET,
      defaultClientId: process.env.RPI_DEFAULT_CLIENT_ID,
      authRequired,
    });
    // The audit line names the account a token-less call runs as (the proxy user).
    setAuditAccount(config.proxyEnabled ? config.proxyUser : null);
    // Pinned, every call runs in the configured tenant — the audit line names it.
    setAuditTenant(tenantPinned() ? config.defaultClientId : null);
    const banner = proxyOnlyBanner(authRequired, config.proxyEnabled, config.proxyUser);
    if (banner) console.error(`[mcp-rpi] ${banner}`);
    const authService = new RPIAuthService(
      config.integrationApiUrl,
      config.oauthClientId,
      config.oauthClientSecret,
      config.proxyUser,
      config.proxyPass,
    );
    // The proxy user's login, once at boot — reported on /health (never the password).
    const proxyLogin = config.proxyEnabled ? await authService.checkProxyLogin() : null;
    if (proxyLogin) console.error(`[mcp-rpi] proxy user "${config.proxyUser}" login at boot: ${proxyLogin}`);
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
    // Fetch the instance's OpenAPI spec ONCE at boot. From that single
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
      proxyLogin,
    };
  }
}

const app = new Hono();
// Local-only first, so a refused page gets no CORS preflight answer either. The
// per-address flood ceiling applies in every mode; token mode adds the validation
// budgets (./validation-guard.ts) and the per-user request budget (on /mcp).
const limiter = new RateLimiter();
if (envCredentialMode) app.use("/*", localOnly());
app.use("/*", peerFloodLimit(limiter));
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
          serverVersion: MCP_RPI_VERSION,
          transport: "http",
          mcp: "degraded",
          reason: setup.reason,
          missing: setup.missing,
        }
      : {
          status: "ok",
          server: "rpi-mcp-server",
          serverVersion: MCP_RPI_VERSION,
          transport: "http",
          mask: { status: setup.maskStatus, maskedCount: setup.maskedCount },
          version: {
            status: setup.versionStatus,
            instance: setup.instanceVersion,
            builtAgainst: BUILT_AGAINST_API_VERSION,
          },
          ...(setup.proxyLogin ? { proxyLogin: setup.proxyLogin } : {}),
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
  // Sessions live in the owner-bound, idle-expiring, capped registry
  // (./session-store.ts).
  // Token mode (callers present their own tokens, any number of them) caps the
  // whole server at TOKEN_MODE_MAX_SESSIONS and each user at 20 (./user-sessions.ts)
  // on top of the per-token cap.
  const sessions = new SessionStore<WebStandardStreamableHTTPServerTransport>(
    authRequired ? { ...SESSION_LIMITS, maxSessions: TOKEN_MODE_MAX_SESSIONS } : SESSION_LIMITS,
  );
  const userSessions = authRequired ? new UserSessions() : null;
  setInterval(() => sessions.sweep(), 60_000).unref?.();
  const { config, authService, oidcVerifier, instanceEndpoints } = setup;
  // Pass oauthDiscoveryEnabled so 401s carry the WWW-Authenticate → PRM
  // challenge exactly when we serve discovery (an OIDC issuer was found).
  const authMw = createRpiAuthMiddleware(
    authService,
    authRequired,
    oidcVerifier,
    !!oidcIssuer,
    authRequired ? new ValidationGuard() : null,
  );
  // After auth, token mode: each verified caller's request budget.
  const perUser = authRequired
    ? [userLimit(limiter, (c) => c.get("callerKey") ?? "anonymous")]
    : [];

  app.all("/mcp", authMw, ...perUser, async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    const authInfo = c.get("authInfo");
    const owner = ownerOf(authInfo?.token);

    // An unknown, foreign or expired session id: ONE identical 404.
    if (sessionId) {
      const existing = sessions.get(sessionId, owner);
      return existing ? existing.handleRequest(c.req.raw, { authInfo }) : c.json(SESSION_NOT_FOUND, 404);
    }

    // A new session: reserve its slots first (the user's, then the token's and the
    // server's), so concurrent initializes can't overshoot a cap.
    const callerKey = c.get("callerKey");
    const userSlot = userSessions && callerKey ? userSessions.reserve(callerKey) : null;
    if (userSlot && !userSlot.ok) return c.json({ error: userSlot.message }, userSlot.status);
    const slot = sessions.reserve(owner);
    if (!slot.ok) {
      userSlot?.release();
      return c.json({ error: slot.message }, slot.status);
    }
    const forget = (id: string): void => {
      sessions.remove(id);
      userSessions?.remove(id);
    };
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string): void => {
        slot.commit(id, transport);
        userSlot?.commit(id);
        console.error(`Session initialized: ${id}`);
      },
      onsessionclosed: (id: string): void => {
        forget(id);
        console.error(`Session closed: ${id}`);
      },
    });

    // Also fires when the store closes an idle session.
    transport.onclose = () => {
      if (transport.sessionId) forget(transport.sessionId);
    };

    try {
      const { server, maskedCount } = createRPIMcpServer(
        config,
        authService,
        oidcVerifier,
        instanceEndpoints,
      );
      if (!setup.degraded) setup.maskedCount = maskedCount;
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, { authInfo });
    } finally {
      // Not an initialize (or it failed): no session came of the slots.
      slot.release();
      userSlot?.release();
    }
  });
}

const port = Number(process.env.RPI_MCP_HTTP_PORT) || 3002;

// Env-credential mode listens on the IPv6 loopback too: Windows resolves
// "localhost" to ::1 first, and a client without happy eyeballs (.NET, PowerShell)
// waits ~2 s on every new connection for the refused ::1 before it falls back to
// 127.0.0.1 (measured). Where ::1 doesn't exist (a container with IPv6 off), the
// IPv4 loopback alone serves.
let ipv6Loopback = false;
if (envCredentialMode) {
  try {
    Bun.serve({ port, hostname: "::1", idleTimeout: 255, ...SERVE_MODE, fetch: app.fetch });
    ipv6Loopback = true;
  } catch (err) {
    console.error(`[mcp-rpi] the IPv6 loopback [::1] is not available (${(err as Error).message}) — 127.0.0.1 only`);
  }
}

// IMPORTANT: use console.error, never console.log (breaks stdio protocol in other contexts)
console.error(
  envCredentialMode
    ? `RPI MCP Server ${MCP_RPI_VERSION} (HTTP) starting on ${LOOPBACK_BIND}:${port}${ipv6Loopback ? ` and [::1]:${port}` : ""} — local only (every call runs as one RPI account: this machine's clients only, no LAN, no web pages from other sites)`
    : `RPI MCP Server ${MCP_RPI_VERSION} (HTTP) starting on port ${port} (all interfaces)`,
);
console.error(`Auth required: ${authRequired}`);
if (setup.degraded) {
  console.error(`MCP mode: DEGRADED (reason: ${setup.reason})`);
}

// TIMEOUT INVARIANT (do not break): tool poll budget < the MCP client's abort
// < this Bun.serve idleTimeout. Currently:
//   selection-rules DEFAULT_TIMEOUT_SECONDS 220s
//   < a client transport timeout (240s is typical)
//   < idleTimeout 255s (Bun's hard ceiling).
// Bun caps idleTimeout at 255s — it is the LOWEST ceiling, which is why the
// tool budget is forced down to 220 (NOT raised to 300 "to match Java
// RPI-MCPServer"; that would silently re-break long-poll tools by letting
// the transport idle-kill the MCP session mid-poll).
export default {
  port,
  ...(envCredentialMode ? { hostname: LOOPBACK_BIND } : {}),
  // Token mode: a request body over TOKEN_MODE_MAX_BODY_BYTES is refused (413)
  // before it is read; no MCP request comes near it.
  ...(authRequired ? { maxRequestBodySize: TOKEN_MODE_MAX_BODY_BYTES } : {}),
  idleTimeout: 255,
  // Production mode, whatever NODE_ENV says (./serve-mode.ts).
  ...SERVE_MODE,
  fetch: app.fetch,
};
