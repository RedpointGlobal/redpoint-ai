import { createMiddleware } from "hono/factory";

/**
 * DRH incoming-auth middleware.
 *
 * DRH tokens are OPAQUE (Keycloak signon "token_value", not JWTs) and DRH has
 * no token-validation endpoint, so — unlike mcp-rpi (JWKS / validate-token) —
 * this middleware does a PRESENCE gate: when AUTH_REQUIRED is on, a request
 * MUST carry `Authorization: Bearer <token>`; the token is forwarded to the
 * DRH backend, which is the real authority (a bad token 401s on the actual
 * call, surfaced by DRHApiClient). This closes the proxy-fallback exploit
 * with auth ON, a tokenless external caller is rejected
 * here, so the service-account proxy token is never lent to an unauth'd caller.
 *
 * Auth OFF (dev / AUTH_REQUIRED=false) → no token required; tools fall back to
 * the proxy token. Deeper validation (an authenticated DRH probe per token) is
 * a future enhancement, gated on confirming a cheap validate endpoint.
 */
export interface DRHAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
}

declare module "hono" {
  interface ContextVariableMap {
    authInfo: DRHAuthInfo | undefined;
  }
}

export function createDrhAuthMiddleware(authRequired: boolean) {
  return createMiddleware(async (c, next) => {
    if (!authRequired) {
      c.set("authInfo", undefined);
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return c.json({ error: "Empty bearer token" }, 401);
    }

    // Presence-gated: forward the caller's token; the DRH backend authorizes it.
    c.set("authInfo", { token, clientId: "drh-user", scopes: [] });
    return next();
  });
}
