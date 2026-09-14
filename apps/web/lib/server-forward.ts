/**
 * Server-side credential forwarding for apps/server reads under AUTH_REQUIRED=true.
 *
 * Every web→apps/server read that goes through the plain `api()` helper in
 * lib/api.ts hits `/api/v1/*` with NO credential. Under auth=false that's fine
 * (the gate is off); under auth=true the gate 401s it. This closes that whole
 * class: it produces the credential header a gated apps/server request needs,
 * derived from the logged-in NextAuth session, entirely server-side so the raw
 * token never reaches browser JS.
 *
 * The sequence mirrors the runtime-status proxy exactly
 * (apps/web/app/api/proxy/runtime-status/[workspaceId]/route.ts):
 *   decode the JWT → if the RPI access token is within the expiry margin,
 *   self-fetch /api/auth/session (which runs the jwt callback → rotates the
 *   cookie with a fresh token) → re-decode the rotated JWT → forward the FRESH
 *   token. Without the re-decode step a server render would forward the stale
 *   request-cookie token and re-trigger the exact "No workspace" 401 as a
 *   refresh race.
 *
 * Credential precedence is FIXED and mirrors apps/server's own gate evaluation
 * order (auth.ts evaluates X-RPI-Token before the Authorization header):
 *   1. rpiAccessToken → `X-RPI-Token`   (rpi-native login)
 *   2. apiKey         → `Authorization: Bearer` (API-key login)
 * Present-one, never both. The two are mutually exclusive by NextAuth provider
 * today; the fixed order keeps it deterministic if that ever changes. There is
 * deliberately NO OIDC-Bearer branch — the web app has no OIDC-login provider,
 * so it would be dead code, and a Keycloak/SSO-backed RPI tenant's token already
 * rides in rpiAccessToken → X-RPI-Token (the gate validates it regardless of
 * issuer). If an OIDC auth-code provider is ever added, extend `pickHeaders`
 * with one branch.
 */

import { getToken } from "next-auth/jwt";

// Dev cookie name (non-Secure). Matches the runtime-status / chat proxies.
const COOKIE_NAME = "authjs.session-token";
// Same 60s margin the jwt callback (lib/auth.ts) and the proxies use.
const REFRESH_TRIGGER_MARGIN_MS = 60_000;

interface JwtPayload {
  apiKey?: string;
  rpiAccessToken?: string;
  rpiExpiresAt?: number;
  /** Per-request RPI Environment Location — forwarded as X-RPI-URL. */
  rpiUrl?: string;
  [key: string]: unknown;
}

export interface ForwardResult {
  /** Credential header for the upstream apps/server request. Empty when the
   *  session carries no forwardable credential (or AUTH_SECRET is unset). */
  headers: Record<string, string>;
  /** Rotated Set-Cookie values from a refresh self-fetch. Route handlers must
   *  append these to their response so the browser cookie advances; server
   *  components cannot set cookies and drop them (the fresh token is still
   *  forwarded — only browser-cookie rotation is deferred to the next proxy
   *  hop / session poll). */
  rotatedCookies: string[];
}

async function decode(cookieHeader: string): Promise<JwtPayload | null> {
  if (!process.env.AUTH_SECRET) return null;
  try {
    return (await getToken({
      req: { headers: new Headers({ cookie: cookieHeader }) },
      secret: process.env.AUTH_SECRET,
      salt: COOKIE_NAME,
      cookieName: COOKIE_NAME,
    })) as JwtPayload | null;
  } catch {
    return null;
  }
}

export function pickHeaders(jwt: JwtPayload | null): Record<string, string> {
  if (!jwt) return {};
  // Precedence: X-RPI-Token first (mirrors the gate's eval order), then apiKey.
  if (typeof jwt.rpiAccessToken === "string") {
    // Carry the per-request Environment Location alongside the token so the
    // read targets the rep's instance. apps/server re-validates it (SSRF).
    return {
      "X-RPI-Token": jwt.rpiAccessToken,
      ...(typeof jwt.rpiUrl === "string" && jwt.rpiUrl
        ? { "X-RPI-URL": jwt.rpiUrl }
        : {}),
    };
  }
  if (typeof jwt.apiKey === "string") {
    return { Authorization: `Bearer ${jwt.apiKey}` };
  }
  return {};
}

/**
 * Build the credential header to forward to a gated apps/server read.
 *
 * @param cookieHeader raw inbound `Cookie` header value (handles chunked JWTs)
 * @param origin absolute base URL for the /api/auth/session refresh self-fetch
 *               (route handlers: `new URL(request.url).origin`; server
 *               components: reconstruct from `headers()` proto+host)
 */
export async function buildForwardHeaders(
  cookieHeader: string,
  origin: string,
): Promise<ForwardResult> {
  let jwt = await decode(cookieHeader);
  let rotatedCookies: string[] = [];

  const expiresAt = jwt?.rpiExpiresAt;
  if (
    jwt?.rpiAccessToken &&
    typeof expiresAt === "number" &&
    Date.now() > expiresAt - REFRESH_TRIGGER_MARGIN_MS
  ) {
    // Near/past expiry: force the jwt callback to run (and rotate the cookie)
    // by hitting the session endpoint, then re-decode the rotated JWT so we
    // forward the refreshed token rather than the stale request-cookie value.
    try {
      const res = await fetch(new URL("/api/auth/session", origin), {
        headers: { cookie: cookieHeader },
      });
      rotatedCookies = res.headers.getSetCookie();
      if (rotatedCookies.length > 0) {
        const rotated = rotatedCookies.map((c) => c.split(";")[0]).join("; ");
        const fresh = await decode(rotated);
        if (fresh) jwt = fresh;
      }
    } catch {
      // Self-fetch failed — forward the pre-refresh token, still valid until
      // actual expiry. The next request's proxy hop / session poll catches up.
    }
  }

  return { headers: pickHeaders(jwt), rotatedCookies };
}
