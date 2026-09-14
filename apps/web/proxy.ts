import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildForwardHeaders } from "@/lib/server-forward";
import { ENV_LOCATION_COOKIE } from "@/lib/env-location";

/**
 * Auth gate. The important subtlety: authenticated ≠ "a session envelope
 * exists". A session whose RPI access token has expired and cannot be
 * refreshed still decodes to a valid JWT, so the old `!session` check let it
 * through — and the downstream workspace read then 401'd into the "No workspace
 * available" dead-end with no route back to login. We instead gate on a LIVE
 * forwardable credential: buildForwardHeaders returns an empty header set
 * exactly when the session carries no usable credential (after attempting a
 * refresh), which is the authoritative "is this request authenticated" signal.
 *
 * Lifecycle map (AUTH_REQUIRED=true):
 *   - no session / no forwardable cred        -> redirect to /login
 *   - live apiKey or live rpiAccessToken      -> forward, render
 *   - near-expiry/expired but refreshable     -> helper refreshes -> forward fresh
 *   - expired + unrefreshable/dead            -> empty headers -> redirect to /login
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // NextAuth internals stay reachable always (the buildForwardHeaders refresh
  // self-fetch below targets /api/auth/session). `/api/rpi-location` is the
  // pre-auth Environment Location signal the LOGIN page fetches, so it must be
  // reachable without a credential too (returns only a non-sensitive is-enabled
  // flag + the default-instance placeholder — never the allowlist contents).
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/rpi-location")
  ) {
    const res = NextResponse.next();
    // Single-use Environment Location carrier: the jwt callback reads it from
    // THIS OIDC callback request, so clearing it on the response here doesn't
    // race that read — it only tells the browser to drop the cookie afterward,
    // so it never lingers or leaks into a later SSO attempt (determinism — no
    // accumulation; the short TTL is a backstop, this is the deterministic clear).
    if (pathname.startsWith("/api/auth/callback")) {
      res.cookies.set(ENV_LOCATION_COOKIE, "", { path: "/", maxAge: 0 });
    }
    return res;
  }

  // Runtime auth mode — read live here (middleware runs per-request), NOT the
  // build-time-inlined client value, so a .env flip takes effect on restart
  // without a rebuild.
  const authOff = process.env.AUTH_REQUIRED === "false";

  // /login: under auth=false there is no login — everything runs as the service
  // account and per-user identity is ignored — so the sign-in form is dead and
  // misleading. Redirect direct/bookmark navigation home. Under auth=true the
  // form must render, and /login stays exempt from the credential gate below
  // (else an unauthenticated user could never reach it — redirect loop).
  if (pathname.startsWith("/login")) {
    return authOff
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }

  if (authOff) {
    return NextResponse.next();
  }

  const { headers, rotatedCookies } = await buildForwardHeaders(
    request.headers.get("cookie") ?? "",
    request.nextUrl.origin,
  );

  if (Object.keys(headers).length === 0) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // A refresh may have rotated the cookie — persist it so the browser advances
  // and the session heals. The prior implementation refreshed only in-memory
  // via auth() and never wrote the cookie back, leaving an expired-but-
  // refreshable session permanently stale (reload after reload showing the
  // empty state).
  const res = NextResponse.next();
  for (const cookie of rotatedCookies) {
    res.headers.append("set-cookie", cookie);
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
