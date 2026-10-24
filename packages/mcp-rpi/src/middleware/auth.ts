import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { decodeJwt } from "jose";
import type { RPIAuthService } from "../client/rpi-auth.js";
import type { OidcVerifier } from "../client/oidc-discovery.js";
import { wwwAuthenticateChallenge } from "../oauth-metadata.js";
import { isAllowedRpiUrl } from "../url-allowlist.js";
import { tooManyRequests } from "../rate-limit.js";
import type { ValidationAdmission } from "../validation-guard.js";
import { ownerOf } from "../session-store.js";

/**
 * Does this JWT's UNVERIFIED `iss` match the configured Keycloak issuer? Used ONLY to
 * ROUTE, never to trust: a token actually issued by Keycloak gets the real JWKS crypto
 * verify; anything else — notably a native RPI token, which is ALSO a 3-part JWT but is
 * signed by RPI's own IdentityServer (different issuer + kid) — skips that verify and is
 * authorized by validateToken instead. Skipping it kills the DOOMED Keycloak JWKS refetch
 * (jose's 5000ms-ceiling remote fetch, re-armed every 30s cooldown) the native token would
 * otherwise trigger and lose every time — the sink behind the "probe timeout after 5s"
 * false negative. Security-neutral: the native token was never verifiable here and already
 * fell through to validateToken; this just skips the wasted attempt. Total — a malformed /
 * undecodable token → false → routed to validateToken, which fails it cleanly. Never throws.
 */
function isKeycloakIssued(token: string, keycloakIssuer: string | undefined): boolean {
  if (!keycloakIssuer) return true; // no configured issuer to gate on → preserve prior behavior
  try {
    const iss = decodeJwt(token).iss;
    // No / non-string iss → not a Keycloak token → route to validateToken (which rejects
    // it cleanly). NEVER silently allow. Normalize both sides (trailing slash + case) so a
    // cosmetic slash/case variant of the SAME issuer can't misroute an SSO token to the
    // skip-verify path (that must never happen) — the actual crypto verify below is still
    // exact (jose), this only decides WHICH path runs.
    if (typeof iss !== "string") return false;
    return normalizeIssuer(iss) === normalizeIssuer(keycloakIssuer);
  } catch {
    return false;
  }
}

/** Canonical issuer for routing comparison: trailing slashes stripped + lowercased. */
function normalizeIssuer(iss: string): string {
  return iss.trim().replace(/\/+$/, "").toLowerCase();
}

export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  /**
   * Per-request RPI target base URL ("Environment Location"), from a VALIDATED
   * `X-RPI-URL` header. Undefined = no per-request location (genuine default
   * path). Threaded to the API client + auth as `options.baseUrl` so the whole
   * request targets the rep's instance, not the boot default.
   */
  targetUrl?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    authInfo: AuthInfo | undefined;
    /**
     * The verified caller, for the per-user budgets: "sub:<issuer>#<subject>" when
     * the token names its subject, else "token:<sha-256 of the token>". Set only
     * when a token was verified.
     */
    callerKey: string | undefined;
  }
}

/** The budgets a NEW remote validation must pass (../validation-guard.ts). */
export interface ValidationBudgets {
  /** Before a new remote validation; an admission is settled with its answer. */
  admit(c: Context): ValidationAdmission;
  /** A presented token failed on an answer this request did not ask RPI for. */
  failed(c: Context): void;
}

/**
 * The caller key for a verified token. Reading the claims unverified is safe here:
 * the token was just verified (JWKS, or accepted by RPI). An opaque token, or one
 * without a subject, is keyed by its hash.
 */
function callerKeyOf(token: string): string {
  try {
    const claims = decodeJwt(token);
    if (typeof claims.sub === "string" && claims.sub) {
      return `sub:${normalizeIssuer(typeof claims.iss === "string" ? claims.iss : "")}#${claims.sub}`;
    }
  } catch {
    // not a JWT
  }
  return `token:${ownerOf(token)}`;
}

export function createRpiAuthMiddleware(
  authService: RPIAuthService,
  authRequired: boolean,
  oidcVerifier?: OidcVerifier | null,
  // When true (MCP OAuth discovery is being served — Mechanism A), every 401
  // carries the RFC 6750 WWW-Authenticate challenge pointing at the PRM so a
  // spec client can (re)discover the authorization server and connect.
  oauthDiscoveryEnabled = false,
  // Token mode: the budgets a new remote validation must pass, and where failures
  // are counted. Absent → validation is unbudgeted (the in-process tests).
  budgets?: ValidationBudgets | null,
) {
  return createMiddleware(async (c, next) => {
    if (!authRequired) {
      c.set("authInfo", undefined);
      return next();
    }

    // MUST be present on EVERY 401 (missing / invalid / expired), so a
    // mid-session client whose token expired can re-bootstrap via the PRM.
    const unauthorized = (message: string) => {
      if (oauthDiscoveryEnabled) {
        c.header("WWW-Authenticate", wwwAuthenticateChallenge(c.req));
      }
      return c.json({ error: message }, 401);
    };

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return unauthorized("Missing or invalid Authorization header");
    }

    const token = authHeader.slice(7);

    // Per-request Environment Location (X-RPI-URL). SSRF-guarded: a non-
    // allowlisted host is rejected outright (400) — we never connect to an
    // arbitrary URL. Absent header = no per-request location (genuine default).
    // Resolved BEFORE token validation so the rep's token is validated against
    // the rep's instance, not the boot default.
    const rawTargetUrl = c.req.header("X-RPI-URL");
    let targetUrl: string | undefined;
    if (rawTargetUrl) {
      if (!isAllowedRpiUrl(rawTargetUrl)) {
        return c.json({ error: "X-RPI-URL host is not allowlisted" }, 400);
      }
      targetUrl = rawTargetUrl;
    }

    // Try JWKS verification first (fast, local crypto) for JWT-shaped tokens ISSUED BY
    // KEYCLOAK. Gate on the issuer (decoded UNVERIFIED — routing only; trust is still the
    // JWKS crypto below for SSO, or validateToken for native): a native RPI token is a
    // 3-part JWT too, but its iss is RPI's IdentityServer, so verifyToken can never succeed
    // and only burns a doomed remote-JWKS refetch — skip straight to validateToken for it.
    // Soft-aud (Option A): if the crypto verify rejects (e.g. an aud we don't recognize) we
    // fall through to validate-token-status — RPI is the single trust domain and validation
    // there is authoritative. See oauth-metadata.ts.
    if (
      oidcVerifier &&
      token.split(".").length === 3 &&
      isKeycloakIssued(token, oidcVerifier.config.issuer)
    ) {
      const result = await oidcVerifier.verifyToken(token);
      if (result.valid) {
        c.set("authInfo", { token, clientId: result.sub, scopes: [], targetUrl });
        c.set("callerKey", callerKeyOf(token));
        return next();
      }
      // Fall through to validateTokenStatus
    }

    // Universal fallback — works for all token types (native, OIDC, Microsoft),
    // validated against the per-request location when one was given. A cached or
    // in-flight answer is free; a new remote validation passes the budgets first
    // (and its admission counts its own failure when RPI answers).
    let askedRpi = false;
    const check = await authService.checkToken(
      token,
      targetUrl,
      budgets
        ? () => {
            const admission = budgets.admit(c);
            askedRpi = admission.ok;
            return admission;
          }
        : undefined,
    );
    if (check.result === "refused") return tooManyRequests(c, check.retryAfterSec);
    if (check.result !== "valid") {
      // RPI unreachable is not the caller's failure; a rejected token is.
      if (check.result === "invalid" && !askedRpi) budgets?.failed(c);
      return unauthorized("Invalid or expired token");
    }

    c.set("authInfo", { token, clientId: "rpi-user", scopes: [], targetUrl });
    c.set("callerKey", callerKeyOf(token));
    return next();
  });
}
