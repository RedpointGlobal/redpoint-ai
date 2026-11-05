import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isAllowedRpiUrl } from "@redpoint-ai/shared";
import { db } from "../store/db.js";
import { apiKeys, apiKeyOwners } from "../store/schema.js";
import { createHash } from "crypto";
import { checkRpiToken } from "../auth/rpi-token-check.js";
import { ValidationGuard } from "../lib/validation-guard.js";
import { tooManyRequests } from "../lib/rate-limit.js";
import { eq } from "drizzle-orm";

export interface AuthUser {
  /** The identity data is scoped to — for an API key, its OWNER (the key acts as them). */
  id: string;
  type: "apikey" | "oidc" | "rpi-user";
  /** API key only: the key's own id. */
  keyId?: string;
  /** API key only: the one workspace the key may reach (others 404), when set. */
  workspaceId?: string;
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
/** RPI Integration API base (no /api/v2 suffix), or null if unconfigured. */
function rpiBaseUrl(): string | null {
  const raw = process.env.RPI_INTEGRATION_API_URL;
  if (!raw) return null;
  return raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
}

const normaliseBase = (base: string) => base.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");

/**
 * The budgets a NEW RPI token validation must pass (../lib/validation-guard.ts, the
 * RPI MCP server's): the failure budget keyed per TOKEN (behind the web
 * proxy every browser request shares one address — an address budget would let
 * one user's failures lock out everyone), and MAX_REMOTE_VALIDATIONS for the whole
 * server, the real ceiling on what RPI can be asked.
 */
export const rpiValidationGuard = new ValidationGuard(Date.now, (c) => {
  const token = c.req.header("X-RPI-Token") ?? "";
  return `token:${createHash("sha256").update(token).digest("hex")}`;
});

/**
 * Validate an RPI user token and resolve the caller's STABLE per-user identity.
 *
 * Returns the RPI/Keycloak user GUID (lowercased) from validate-token-status'
 * top-level `id` — the SAME across token refreshes and re-logins, so per-user usage
 * aggregates instead of fragmenting. Returns null (→ the caller fails closed) when
 * RPI is unconfigured, the token is invalid/expired, RPI is unreachable, or a valid
 * token yields no usable id. It NEVER falls back to a token hash. Cached, capped,
 * single-flight (../auth/rpi-token-check.ts); no budget here (the A2A path).
 */
export async function validateRpiToken(
  token: string,
  targetBase?: string,
): Promise<string | null> {
  const base = targetBase ? normaliseBase(targetBase) : rpiBaseUrl();
  if (!base) return null;
  const check = await checkRpiToken(token, base);
  return check.result === "valid" ? check.stableId : null;
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
    // A NEW validation passes the budgets first (a cached or in-flight answer is
    // free); over them → 429 without calling RPI.
    const base = rpiUrl ? normaliseBase(rpiUrl) : rpiBaseUrl();
    if (base) {
      let askedRpi = false;
      const check = await checkRpiToken(rpiToken, base, () => {
        const admission = rpiValidationGuard.admit(c);
        askedRpi = admission.ok;
        return admission;
      });
      if (check.result === "refused") return tooManyRequests(c, check.retryAfterSec);
      if (check.result === "valid") {
        c.set("user", { id: `rpi:${check.stableId}`, type: "rpi-user" });
        return next();
      }
      // A rejected token counts against its budget; RPI unreachable is not the caller's failure.
      if (check.result === "invalid" && !askedRpi) rpiValidationGuard.failed(c);
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

    // A workspace-scoped key reaches its workspace only: any other workspace's
    // routes answer the same 404 an unknown id does.
    if (keyRecord.workspaceId) {
      const m = c.req.path.match(/^\/api\/v1\/workspaces\/([^/]+)/);
      if (m && m[1] !== keyRecord.workspaceId) return c.json({ error: "Not found" }, 404);
    }

    // Update last used timestamp (fire and forget)
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, keyRecord.id))
      .run();

    // The key acts AS its owner (the identity that minted it) for data scoping; a
    // key minted before owners were recorded acts as itself.
    const [owner] = await db.select().from(apiKeyOwners).where(eq(apiKeyOwners.keyId, keyRecord.id));
    c.set("user", {
      id: owner?.userId ?? `apikey:${keyRecord.id}`,
      type: "apikey",
      keyId: keyRecord.id,
      workspaceId: keyRecord.workspaceId ?? undefined,
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
