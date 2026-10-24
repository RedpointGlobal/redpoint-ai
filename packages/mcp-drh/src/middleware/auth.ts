import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { DRHAuthService } from "../client/drh-auth.js";
import { tooManyRequests } from "../rate-limit.js";
import { ownerOf } from "../session-store.js";
import type { ValidationAdmission } from "../validation-guard.js";

/**
 * DRH incoming-auth middleware.
 *
 * DRH tokens are OPAQUE (Keycloak signon "token_value", not JWTs) and DRH has
 * no tenant-agnostic token-validation endpoint, so this middleware does a
 * PRESENCE gate: when AUTH_REQUIRED is on, a request MUST carry
 * `Authorization: Bearer <token>`; the
 * token is forwarded to the DRH backend, which is the real authority (a bad token
 * 401s on the actual call, surfaced by DRHApiClient). This closes the proxy-fallback
 * exploit: with auth ON a tokenless external caller is rejected here, so the
 * service-account proxy token is never lent to an unauth'd caller.
 *
 * Auth OFF (dev / AUTH_REQUIRED=false) → no token required; tools fall back to
 * the proxy token (and the server is then local-only — see http.ts).
 *
 * Token mode requires the tenant pin (http.ts refuses to boot otherwise), and then
 * the token IS checked at the gate (`validation`): the one cheap authenticated DRH
 * read (GET /api-op/v1/databases/default, which 401s an absent or invalid token) is
 * tenant-scoped, and the pin makes it sound — one tenant. ONLY a 401 rejects. The
 * check is budgeted and cached (../validation-guard.ts, DRHAuthService.checkToken),
 * so an invented token opens no session and never reaches a tool.
 */
export interface DRHAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
}

declare module "hono" {
  interface ContextVariableMap {
    authInfo: DRHAuthInfo | undefined;
    /** The caller, for the per-user budgets: "token:<sha-256 of the token>" (DRH tokens are opaque). */
    callerKey: string | undefined;
  }
}

/** The budgets a NEW token check must pass (../validation-guard.ts). */
export interface ValidationBudgets {
  /** Before a new token check; an admission is settled with its answer. */
  admit(c: Context): ValidationAdmission;
  /** A presented token failed on an answer this request did not ask DRH for. */
  failed(c: Context): void;
}

/** The token check at the gate: DRH's answer for the pinned tenant, budgeted. */
export interface TokenValidation {
  auth: Pick<DRHAuthService, "checkToken">;
  tenant: string;
  budgets: ValidationBudgets;
}

export function createDrhAuthMiddleware(authRequired: boolean, validation?: TokenValidation | null) {
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

    if (validation) {
      // A cached or in-flight answer is free; a new check passes the budgets first
      // (and its admission counts its own failure when DRH answers).
      let askedDrh = false;
      const check = await validation.auth.checkToken(token, validation.tenant, () => {
        const admission = validation.budgets.admit(c);
        askedDrh = admission.ok;
        return admission;
      });
      if (check.result === "refused") return tooManyRequests(c, check.retryAfterSec);
      if (check.result !== "valid") {
        // DRH unreachable is not the caller's failure; a rejected token is.
        if (check.result === "invalid" && !askedDrh) validation.budgets.failed(c);
        return c.json({ error: "Invalid or expired token" }, 401);
      }
    }

    // Forward the caller's token; the DRH backend authorizes each call.
    c.set("authInfo", { token, clientId: "drh-user", scopes: [] });
    c.set("callerKey", `token:${ownerOf(token)}`);
    return next();
  });
}
