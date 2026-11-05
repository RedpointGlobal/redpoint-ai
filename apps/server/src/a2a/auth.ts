/**
 * A2A inbound authentication.
 *
 * The mode is declared explicitly with A2A_AUTH_MODE — there is NO default and NO
 * fallback between modes:
 *   - "bearer": one static A2A_BEARER_TOKEN (requireBearer in server.ts, unchanged).
 *   - "oidc":   a per-user token, verified the same two-step way mcp-rpi's middleware
 *               does (RPI is the single trust domain): first locally as a JWT from
 *               the RPI realm's OpenID provider (discovered at boot from RPI's
 *               login-settings; JWKS, issuer, audience — ../auth/oidc-discovery.ts);
 *               when that fails, by RPI itself (validate-token-status gives the
 *               user id; the username comes from the realm token bound to that id,
 *               or from the caller's user-profile for a native RPI token).
 *               Service identities are refused on both paths.
 * No mode, an unknown mode, or a failed oidc discovery → the A2A server does not
 * start (fail-closed); the app server keeps running.
 *
 * In oidc mode an Express middleware verifies the token BEFORE the JSON-RPC handler
 * runs and attaches the verified identity to the request; the SDK userBuilder only
 * reads it back (the SDK calls the builder inside its own try, so a throwing builder
 * would become a JSON-RPC internal error instead of a 401).
 */
import type { NextFunction, Request, Response } from "express";
import type { RequestContext, User } from "@a2a-js/sdk/server";
import { UnauthenticatedUser } from "@a2a-js/sdk/server";
import { decodeJwt } from "jose";
import {
  createOidcVerifier,
  discoverOidcConfig,
  type LoginSetting,
  type LoginSettingsSource,
  type OidcConfig,
  type OidcVerifier,
} from "../auth/oidc-discovery.js";

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/** The resolved inbound auth the A2A server runs with. */
export type A2AAuth =
  | { mode: "bearer"; bearerToken: string }
  | { mode: "oidc"; verifier: OidcVerifier; rpiIdentity: RpiIdentitySource; proxyUser?: string };

/** A caller's user identity, resolved from a verified token. */
export type UserIdentity = { sub: string; username: string };

/** Resolves a token RPI accepts to its user identity (null = RPI does not accept it). */
export interface RpiIdentitySource {
  resolve(token: string): Promise<UserIdentity | null>;
}

/** apps/server's RPI token validation (middleware/auth.ts validateRpiToken): stable user id or null. */
export type ValidateRpiToken = (token: string, targetBase?: string) => Promise<string | null>;

type Env = Record<string, string | undefined>;

/**
 * Read A2A_AUTH_MODE (+ what that mode needs) from the environment. Pure.
 * Returns the reason the A2A server must not start when the configuration is
 * missing or invalid.
 */
export function resolveA2AAuthMode(
  env: Env,
): { mode: "bearer"; bearerToken: string } | { mode: "oidc"; rpiBaseUrl: string } | { error: string } {
  const mode = env.A2A_AUTH_MODE?.trim();
  if (!mode) return { error: 'A2A_AUTH_MODE is not set (use "oidc" or "bearer")' };
  if (mode === "bearer") {
    if (!env.A2A_BEARER_TOKEN) return { error: "A2A_AUTH_MODE=bearer but A2A_BEARER_TOKEN is not set" };
    return { mode: "bearer", bearerToken: env.A2A_BEARER_TOKEN };
  }
  if (mode === "oidc") {
    const raw = env.RPI_INTEGRATION_API_URL;
    if (!raw) return { error: "A2A_AUTH_MODE=oidc but RPI_INTEGRATION_API_URL is not set" };
    return { mode: "oidc", rpiBaseUrl: raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "") };
  }
  return { error: `A2A_AUTH_MODE="${mode}" is not valid (use "oidc" or "bearer")` };
}

/**
 * RPI's unauthenticated login-settings, fetched the same way the MCP server's
 * RPIAuthService.getLoginSettings does (array body, or { settings: [...] }).
 */
export function rpiLoginSettingsSource(rpiBaseUrl: string): LoginSettingsSource {
  return {
    async getLoginSettings(): Promise<LoginSetting[]> {
      const response = await fetch(`${rpiBaseUrl}/api/v2/authentication/login-settings`);
      if (!response.ok) {
        throw new Error(`Failed to fetch login settings: ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as LoginSetting[] | { settings: LoginSetting[] };
      return Array.isArray(body) ? body : (body.settings ?? []);
    },
  };
}

function normalizeIssuer(iss: string): string {
  return iss.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The claims of a token issued by the realm's OpenID provider — decoded, NOT
 * verified (RPI validates the token; this only routes and reads) — or null for
 * any other token. Routing mirrors mcp-rpi's isKeycloakIssued: a native RPI token
 * is also a 3-part JWT, but its iss is RPI's own IdentityServer.
 */
function realmClaimsOf(token: string, realmIssuer: string): Record<string, unknown> | null {
  try {
    const claims = decodeJwt(token) as Record<string, unknown>;
    if (typeof claims.iss !== "string") return null;
    return normalizeIssuer(claims.iss) === normalizeIssuer(realmIssuer) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * The RPI half of the two-step verification. RPI validates the token
 * (validate-token-status → the caller's stable user id, via apps/server's
 * validateRpiToken) — the identity is always that RPI-returned id. The username:
 *   - a realm-issued token: its own preferred_username, and its sub MUST equal the
 *     id RPI validated (RPI authenticated this exact token; the binding ties its
 *     claims to RPI's answer). RPI's user-profile does not serve these tokens.
 *   - any other (native RPI) token: the caller's user-profile, which must name the
 *     SAME user id.
 * Anything else (rejected token, RPI unreachable, no username, id mismatch) → null.
 */
export function rpiUserIdentitySource(
  rpiBaseUrl: string,
  realmIssuer: string,
  validateRpiToken: ValidateRpiToken,
  fetchImpl: typeof fetch = fetch,
): RpiIdentitySource {
  return {
    async resolve(token: string): Promise<UserIdentity | null> {
      const stableId = await validateRpiToken(token, rpiBaseUrl);
      if (!stableId) return null;
      const realmClaims = realmClaimsOf(token, realmIssuer);
      if (realmClaims) {
        const sub = typeof realmClaims.sub === "string" ? realmClaims.sub.trim().toLowerCase() : "";
        const username = typeof realmClaims.preferred_username === "string" ? realmClaims.preferred_username.trim() : "";
        return sub === stableId && username ? { sub: stableId, username } : null;
      }
      try {
        const res = await fetchImpl(`${rpiBaseUrl}/api/v2/authentication/user-profile`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const profile = (await res.json()) as { id?: string | null; username?: string | null };
        const username = profile.username?.trim() ?? "";
        if (!username || profile.id?.trim().toLowerCase() !== stableId) return null;
        return { sub: stableId, username };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve the inbound auth for the A2A server, running oidc discovery when that
 * mode is declared. Any failure → { error } (the server is not started). The
 * discovery / verifier factories and the RPI token validation are injectable for
 * tests (the default validation is apps/server's validateRpiToken).
 */
export async function prepareA2AAuth(
  env: Env,
  deps: {
    discover?: (source: LoginSettingsSource) => Promise<OidcConfig | null>;
    createVerifier?: (config: OidcConfig) => OidcVerifier;
    validateRpiToken?: ValidateRpiToken;
  } = {},
): Promise<{ auth: A2AAuth } | { error: string }> {
  const resolved = resolveA2AAuthMode(env);
  if ("error" in resolved) return resolved;
  if (resolved.mode === "bearer") return { auth: resolved };
  const discover = deps.discover ?? discoverOidcConfig;
  const createVerifier = deps.createVerifier ?? createOidcVerifier;
  const config = await discover(rpiLoginSettingsSource(resolved.rpiBaseUrl));
  if (!config) return { error: "A2A_AUTH_MODE=oidc but OIDC discovery found no OpenID provider" };
  const validateRpiToken = deps.validateRpiToken ?? (await import("../middleware/auth.js")).validateRpiToken;
  return {
    auth: {
      mode: "oidc",
      verifier: createVerifier(config),
      rpiIdentity: rpiUserIdentitySource(resolved.rpiBaseUrl, config.issuer, validateRpiToken),
      proxyUser: env.RPI_PROXY_USER?.trim() || undefined,
    },
  };
}

/** The verified caller, attached to the request by requireOidcUser. */
export class A2AVerifiedUser implements User {
  constructor(
    readonly sub: string,
    readonly username: string,
    /** The caller's verified token, forwarded to the MCP tools. */
    readonly token: string,
  ) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.username;
  }
}

type RequestWithUser = Request & { a2aUser?: A2AVerifiedUser };

/**
 * A service identity, not a user: an app-only / client-credentials token (Keycloak
 * names those "service-account-<client>"), or the configured proxy service user
 * (RPI_PROXY_USER).
 */
export function isServiceIdentity(username: string, proxyUser?: string): boolean {
  if (/^service-account-/i.test(username)) return true;
  return !!proxyUser && username.toLowerCase() === proxyUser.toLowerCase();
}

/** The user a verified JWT belongs to — or null for a token with no user identity. */
export function userIdentityOf(claims: Record<string, unknown>, proxyUser?: string): UserIdentity | null {
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const username = typeof claims.preferred_username === "string" ? claims.preferred_username.trim() : "";
  if (!sub || !username) return null;
  if (isServiceIdentity(username, proxyUser)) return null;
  return { sub, username };
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

/**
 * oidc mode: verify the caller's token and attach the user to the request. First
 * locally as a JWT (signature via JWKS, issuer, audience, expiry); when that fails,
 * by RPI (the same fallback mcp-rpi uses). A service identity is refused on both
 * paths. The agent card stays public.
 */
export function requireOidcUser(auth: Omit<Extract<A2AAuth, { mode: "oidc" }>, "mode">) {
  const { verifier, rpiIdentity, proxyUser } = auth;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.path === AGENT_CARD_PATH) return next();
    const match = (req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!match) return unauthorized(res, "Unauthorized: missing Bearer token");
    const token = match[1]!;
    const result = await verifier.verifyToken(token);
    let identity: UserIdentity | null;
    if (result.valid) {
      identity = userIdentityOf(result.claims as Record<string, unknown>, proxyUser);
    } else {
      const rpiUser = await rpiIdentity.resolve(token);
      if (!rpiUser) return unauthorized(res, "Unauthorized: invalid or expired token");
      identity = isServiceIdentity(rpiUser.username, proxyUser) ? null : rpiUser;
    }
    if (!identity) return unauthorized(res, "Unauthorized: the token has no user identity");
    (req as RequestWithUser).a2aUser = new A2AVerifiedUser(identity.sub, identity.username, token);
    next();
  };
}

/** SDK userBuilder for oidc mode — only reads what requireOidcUser attached; never throws. */
export async function oidcUserBuilder(req: Request): Promise<User> {
  return (req as RequestWithUser).a2aUser ?? new UnauthenticatedUser();
}

/**
 * The verified caller's token to forward to the MCP tools (the same per-user path
 * the web chat uses) — undefined unless the request carries an A2AVerifiedUser.
 */
export function forwardedTokenOf(requestContext: Pick<RequestContext, "context">): string | undefined {
  const user = requestContext.context?.user;
  return user instanceof A2AVerifiedUser ? user.token : undefined;
}

/** One MCP connection of the A2A workspace, as far as the per-user check needs it. */
export type McpConnectionRef = { name: string; transport: string; url?: string };

/**
 * oidc mode forwards each caller's token to the workspace's MCP servers. An MCP
 * server that does not enforce per-user auth ACCEPTS a request with no token — and
 * then ignores any forwarded token too (mcp-rpi with AUTH_REQUIRED=false drops the
 * Authorization header and runs every call as its service account). So at boot every
 * MCP connection must be http and must refuse an unauthenticated request with 401;
 * anything else → the A2A server is not started. Bounded retries cover an MCP server
 * that is still starting.
 */
export async function checkPerUserMcp(
  connections: readonly McpConnectionRef[],
  opts: { fetchImpl?: typeof fetch; attempts?: number; delayMs?: number } = {},
): Promise<{ ok: true } | { error: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? 2000;
  if (connections.length === 0) return { error: "A2A_AUTH_MODE=oidc but the A2A workspace has no MCP connection" };
  for (const conn of connections) {
    if (conn.transport !== "http" || !conn.url)
      return { error: `A2A_AUTH_MODE=oidc but MCP "${conn.name}" is not an http connection — per-user tokens can't be forwarded to it` };
    let status: number | null = null;
    for (let i = 0; i < attempts && status === null; i++) {
      try {
        const res = await fetchImpl(conn.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "a2a-auth-check", version: "0" } },
          }),
          signal: AbortSignal.timeout(5000),
        });
        status = res.status;
      } catch {
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (status === null)
      return { error: `A2A_AUTH_MODE=oidc but MCP "${conn.name}" could not be reached to confirm it enforces per-user auth` };
    if (status !== 401)
      return {
        error: `A2A_AUTH_MODE=oidc but MCP "${conn.name}" accepted a request with no token (HTTP ${status}) — it would ignore forwarded user tokens and run as its service account (for mcp-rpi: set AUTH_REQUIRED=true)`,
      };
  }
  return { ok: true };
}
