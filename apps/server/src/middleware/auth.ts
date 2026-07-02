import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { db } from "../store/db.js";
import { apiKeys } from "../store/schema.js";
import { eq } from "drizzle-orm";

export interface AuthUser {
  id: string;
  type: "apikey" | "oidc";
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

/**
 * Auth middleware. Supports:
 * - API key: `Authorization: Bearer rpai_...`
 * - OIDC JWT: `Authorization: Bearer eyJ...`
 *
 * Set AUTH_REQUIRED=false to disable (dev mode).
 */
export const authMiddleware = createMiddleware(async (c, next) => {
  // Skip auth if disabled (dev mode)
  if (process.env.AUTH_REQUIRED === "false") {
    c.set("user", { id: "dev-user", type: "apikey" });
    return next();
  }

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
