import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isAllowedRpiUrl } from "@redpoint-ai/shared";
import { db } from "../store/db.js";
import { apiKeys } from "../store/schema.js";
import { eq } from "drizzle-orm";

export interface AuthUser {
  id: string;
  type: "apikey" | "oidc" | "rpi-user";
  workspaceId?: string;
  permissions?: string[];
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

/**
 * Hash an API key for storage/comparison using SHA-256.
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a new API key with prefix.
 */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `rpai_${key}`;
}

// Cache JWKS endpoint
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwks && process.env.OIDC_JWKS_URI) {
    jwks = createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URI));
  }
  return jwks;
}

// --- Mechanism B: RPI-native web session support ----------------------------
// An RPI-native web login (apps/web rpi-native NextAuth provider) carries the
// RPI user token in `X-RPI-Token` (same channel as chat) and has NO rpai_
// apiKey. Accept it as a first-class credential by validating against RPI's
// `validate-token-status` — the SAME universal-fallback mechanism the mcp-rpi
// middleware already uses. Cached briefly (mirrors mcp-rpi) so a polled endpoint
// like runtime-status doesn't hit RPI on every request.
/**
 * RPI's empty/default GUID (its documented "no value" sentinel for a guid field).
 * A validate-token-status response carrying this as `id` has resolved NO real
 * principal, so we treat it as unresolved rather than attribute usage to it.
 */
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

const RPI_TOKEN_CACHE_TTL_MS = 30_000;
// Cache the RESOLVED STABLE ID (or null) per token, not a bare boolean: the id is
// what makes per-user metering converge, and it comes from the SAME
// validate-token-status call, so caching it costs no extra round-trip.
const rpiTokenCache = new Map<
  string,
  { stableId: string | null; expiresAt: number }
>();

/** RPI Integration API base (no /api/v2 suffix), or null if unconfigured. */
function rpiBaseUrl(): string | null {
  const raw = process.env.RPI_INTEGRATION_API_URL;
  if (!raw) return null;
  return raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
}

/**
 * Validate an RPI user token and resolve the caller's STABLE per-user identity.
 *
 * Returns the RPI/Keycloak user GUID (lowercased) from validate-token-status'
 * top-level `id` — an identity that is the SAME across token refreshes and
 * re-logins. Keying the principal on it lets per-user usage aggregate instead of
 * fragmenting: the previous token-hash id changed every time apps/web refreshed
 * or re-minted the rpiAccessToken (~hourly), splitting one user across many ids.
 *
 * Returns null (→ caller fails closed) when RPI is unconfigured, the token is
 * invalid/expired, RPI is unreachable, or a valid token yields no usable id.
 * It NEVER falls back to a token hash: that hash rotates with the token and is
 * exactly the fragmentation this removes, so a validated-but-unattributable token
 * is an auth failure, not a silently mis-keyed principal.
 */
async function validateRpiToken(
  token: string,
  // Per-request Environment Location (validated X-RPI-URL). Validate the token
  // against the rep's instance, not the boot default. Normalised + cache-keyed
  // by base so the same token isn't conflated across instances.
  targetBase?: string,
): Promise<string | null> {
  const base = targetBase
    ? targetBase.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "")
    : rpiBaseUrl();
  if (!base) return null;
  const keyHash = `${base}::${await hashApiKey(token)}`;
  const cached = rpiTokenCache.get(keyHash);
  if (cached && Date.now() < cached.expiresAt) return cached.stableId;
  let stableId: string | null = null;
  try {
    const res = await fetch(
      `${base}/api/v2/authentication/validate-token-status`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      // GUIDs are case-insensitive — normalise so a casing flip can't re-split
      // the same identity. Ignore the empty-guid sentinel.
      const body = (await res.json()) as { id?: string | null };
      const raw = body?.id?.trim().toLowerCase();
      if (raw && raw !== EMPTY_GUID) stableId = raw;
    }
  } catch {
    stableId = null;
  }
  rpiTokenCache.set(keyHash, {
    stableId,
    expiresAt: Date.now() + RPI_TOKEN_CACHE_TTL_MS,
  });
  return stableId;
}

/**
 * Auth middleware. Supports (evaluated in this order):
 * - RPI user token: `X-RPI-Token: <rpi token>` — the RPI-native web session
 *   (no rpai_ apiKey); validated via RPI validate-token-status. Checked FIRST,
 *   ahead of the Authorization early-401, so it is not dead code.
 * - API key: `Authorization: Bearer rpai_...`
 * - OIDC JWT: `Authorization: Bearer eyJ...`
 *
 * Authorization stays the app-identity channel; X-RPI-Token is the RPI user
 * token (consistent with chat). Set AUTH_REQUIRED=false to disable (dev mode).
 */
export const authMiddleware = createMiddleware(async (c, next) => {
  // Skip auth if disabled (dev mode)
  if (process.env.AUTH_REQUIRED === "false") {
    c.set("user", { id: "dev-user", type: "apikey" });
    return next();
  }

  // Mechanism B — RPI-native web session (X-RPI-Token, no rpai_ apiKey).
  // MUST be evaluated BEFORE the Authorization early-401 below, or it is dead
  // code (the RPI-native user has no Authorization credential the gate accepts).
  const rpiToken = c.req.header("X-RPI-Token");
  if (rpiToken) {
    // Per-request Environment Location (X-RPI-URL): SSRF-guard it and validate
    // the token against THAT instance (the rep's), not the boot default. A
    // non-allowlisted host is rejected outright (400) — never connected to.
    // Absent = default instance.
    const rpiUrl = c.req.header("X-RPI-URL") ?? undefined;
    if (rpiUrl && !isAllowedRpiUrl(rpiUrl)) {
      return c.json({ error: "X-RPI-URL host is not allowlisted" }, 400);
    }
    // Key the principal on the caller's STABLE RPI identity (the user GUID from
    // validate-token-status), NOT a hash of the token: the token rotates on
    // refresh/re-login, so a token-hash id fragments one user's usage across
    // many ids and breaks per-user metering. A validated token that resolves no
    // stable id falls through (→ early-401), never a token hash.
    const stableId = await validateRpiToken(rpiToken, rpiUrl);
    if (stableId) {
      c.set("user", { id: `rpi:${stableId}`, type: "rpi-user" });
      return next();
    }
  }
  // Invalid/absent/unresolvable X-RPI-Token falls through: an app-identity
  // Authorization may still authorize; otherwise the early-401 below fails closed.

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  // API key auth
  if (token.startsWith("rpai_")) {
    const keyHash = await hashApiKey(token);
    const [keyRecord] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash));

    if (!keyRecord) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
      return c.json({ error: "API key expired" }, 401);
    }

    // Update last used timestamp (fire and forget)
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, keyRecord.id))
      .run();

    c.set("user", {
      id: keyRecord.id,
      type: "apikey",
      workspaceId: keyRecord.workspaceId ?? undefined,
      permissions: keyRecord.permissions
        ? JSON.parse(keyRecord.permissions)
        : undefined,
    });
    return next();
  }

  // OIDC JWT auth
  const jwksEndpoint = getJWKS();
  if (!jwksEndpoint) {
    return c.json(
      { error: "OIDC not configured. Set OIDC_JWKS_URI and OIDC_ISSUER." },
      401,
    );
  }

  try {
    const { payload } = await jwtVerify(token, jwksEndpoint, {
      issuer: process.env.OIDC_ISSUER,
      audience: process.env.OIDC_AUDIENCE,
    });

    c.set("user", {
      id: (payload.sub as string) || "unknown",
      type: "oidc",
    });
    return next();
  } catch {
    return c.json({ error: "Invalid or expired JWT" }, 401);
  }
});
