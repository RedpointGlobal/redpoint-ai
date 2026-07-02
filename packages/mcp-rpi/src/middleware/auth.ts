import { createMiddleware } from "hono/factory";
import type { RPIAuthService } from "../client/rpi-auth.js";
import type { OidcVerifier } from "../client/oidc-discovery.js";

export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
}

declare module "hono" {
  interface ContextVariableMap {
    authInfo: AuthInfo | undefined;
  }
}

export function createRpiAuthMiddleware(
  authService: RPIAuthService,
  authRequired: boolean,
  oidcVerifier?: OidcVerifier | null,
) {
  return createMiddleware(async (c, next) => {
    if (!authRequired) {
      c.set("authInfo", undefined);
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        { error: "Missing or invalid Authorization header" },
        401,
      );
    }

    const token = authHeader.slice(7);

    // Try JWKS verification first (fast, local crypto) for JWT-shaped tokens
    if (oidcVerifier && token.split(".").length === 3) {
      const result = await oidcVerifier.verifyToken(token);
      if (result.valid) {
        c.set("authInfo", { token, clientId: result.sub, scopes: [] });
        return next();
      }
      // Fall through to validateTokenStatus
    }

    // Universal fallback — works for all token types (native, OIDC, Microsoft)
    const valid = await authService.validateToken(token);
    if (!valid) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    c.set("authInfo", { token, clientId: "rpi-user", scopes: [] });
    return next();
  });
}
