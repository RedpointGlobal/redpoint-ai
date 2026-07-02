/**
 * POST /api/proxy/chat/[workspaceId] — server-side proxy for the chat stream.
 *
 * Why a proxy: cookie-only RPI token storage. The browser holds an encrypted
 * HttpOnly NextAuth cookie that contains the RPI access_token; we deliberately
 * do NOT project that token into the JS-visible session anymore (see
 * `apps/web/lib/auth.ts` session callback). So the chat-panel can't attach
 * the Bearer itself — instead it POSTs to this proxy, which:
 *
 *   1. Decrypts the cookie server-side via @auth/core's `Auth()` — that fires
 *      `callbacks.jwt` which lazily refreshes the access_token if it's within
 *      RPI_REFRESH_MARGIN_MS of expiry, and returns a Response whose
 *      Set-Cookie carries the rotated session JWT.
 *   2. Decodes the (now-fresh) JWT to read `rpiAccessToken`. The session
 *      callback strips access_token from its projection so we go directly
 *      to the JWT instead of the session body.
 *   3. Forwards the request to apps/server with `X-RPI-Token` set, streaming
 *      the request body via `duplex: "half"` (Bun + undici both support it).
 *   4. Returns the upstream Response — body is a ReadableStream, which
 *      Next.js v16 App Router pipes straight through without buffering.
 *      The rotated Set-Cookie from step 1 is appended so the browser's
 *      cookie stays in sync with the refreshed JWT.
 *
 * Why not the higher-level `auth()` from next-auth? It calls
 * `getSession(...).then(r => r.json())` which discards the response object —
 * the rotated Set-Cookie never reaches the browser. `Auth()` from @auth/core
 * preserves it.
 *
 * Failure modes (all fall back gracefully, preserving pre-PR behavior):
 *   - No / malformed / expired cookie → no Bearer attached → apps/server
 *     uses the proxy-user fallback (when configured).
 *   - Refresh rejected (refresh_token expired/revoked) → callbacks.jwt clears
 *     `rpi.*` fields, no Bearer attached → proxy-user fallback. Header in
 *     the UI reverts to "Connect RPI" on the next session read.
 *   - apps/server unreachable → 502/503 from upstream surfaces as 502 here.
 */

import { getToken } from "next-auth/jwt";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

// Trigger an in-process /api/auth/session self-fetch (which fires
// callbacks.jwt → may refresh the access_token → rotates the cookie) only
// when the JWT is within this many ms of expiry. Most requests skip the
// refresh hop entirely (saves ~110-150ms each); only the rare request that
// lands in the 60-second margin window pays the rotation cost.
const REFRESH_TRIGGER_MARGIN_MS = 60_000;

interface JwtPayload {
  rpiAccessToken?: string;
  rpiExpiresAt?: number;
  [key: string]: unknown;
}

// Cookie name NextAuth v5 uses for the session JWT. Auth.js renamed the
// prefix from "next-auth" to "authjs" in v5; we match either for safety
// during the v4→v5 transition. The `__Secure-` prefix is added in
// production HTTPS contexts; getToken() handles that automatically when
// secureCookie is set.
const COOKIE_NAME = "authjs.session-token";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await ctx.params;

  // Step 1 — read the access_token + expiry from the inbound JWT.
  //
  // getToken() handles:
  //   - CHUNKED cookies (NextAuth splits large JWTs across `.0`, `.1`, ...
  //     when the encoded JWT exceeds ~4KB).
  //   - The `__Secure-` cookie-name prefix in production HTTPS.
  //
  // This is the PRE-refresh JWT — fast path (no in-process self-fetch).
  // We only trigger the refresh self-fetch in step 2 if the token is
  // actually near expiry; most requests skip that hop entirely.
  let accessToken: string | undefined;
  let expiresAt: number | undefined;
  if (process.env.AUTH_SECRET) {
    try {
      const decoded = (await getToken({
        req: request,
        secret: process.env.AUTH_SECRET,
        salt: COOKIE_NAME,
        cookieName: COOKIE_NAME,
      })) as JwtPayload | null;
      if (typeof decoded?.rpiAccessToken === "string") {
        accessToken = decoded.rpiAccessToken;
      }
      if (typeof decoded?.rpiExpiresAt === "number") {
        expiresAt = decoded.rpiExpiresAt;
      }
    } catch (err) {
      console.error("[proxy.chat] inbound JWT decode failed:", err);
    }
  }

  // Step 2 — trigger callbacks.jwt + cookie rotation ONLY when the access
  // token is actually near expiry. Self-fetching /api/auth/session is a
  // ~110-150ms loopback hop through NextAuth's full route handler — too
  // expensive to do on every chat request.
  //
  // Without this trigger, callbacks.jwt would only run when the browser's
  // useSession() polling fires (which happens on window-focus by default,
  // not time-based) — so a long-lived inactive tab could outlive the
  // access_token and never refresh. This conditional self-fetch fixes that
  // window: any chat request that lands in the 60-second margin pays the
  // cost ONCE per token cycle (~hourly), and the rotated cookie reaches
  // the browser via Set-Cookie on the proxy response.
  let rotatedCookies: string[] = [];
  if (
    accessToken &&
    typeof expiresAt === "number" &&
    Date.now() > expiresAt - REFRESH_TRIGGER_MARGIN_MS
  ) {
    const sessionUrl = new URL("/api/auth/session", request.url);
    try {
      const sessionResponse = await fetch(sessionUrl, {
        headers: { cookie: request.headers.get("cookie") ?? "" },
      });
      // Use the multi-value getter — chunked JWTs span multiple cookies
      // (.0/.1/...). headers.get("set-cookie") would return only the first,
      // leaving the browser with a malformed half-rotated cookie.
      rotatedCookies = sessionResponse.headers.getSetCookie();

      // After refresh, re-decode the now-rotated JWT to forward the FRESH
      // access_token to apps/server (otherwise we'd send the stale-but-
      // -still-valid pre-refresh token, which works but is suboptimal once
      // we've already paid for the refresh hop).
      if (rotatedCookies.length > 0 && process.env.AUTH_SECRET) {
        // Build a synthesized cookie header from the rotated Set-Cookie
        // entries — strip cookie attrs (Path, HttpOnly, etc.), keep only
        // name=value pairs separated by "; ".
        const cookieHeader = rotatedCookies
          .map((c) => c.split(";")[0])
          .join("; ");
        try {
          const refreshed = (await getToken({
            req: { headers: new Headers({ cookie: cookieHeader }) },
            secret: process.env.AUTH_SECRET,
            salt: COOKIE_NAME,
            cookieName: COOKIE_NAME,
          })) as JwtPayload | null;
          if (typeof refreshed?.rpiAccessToken === "string") {
            accessToken = refreshed.rpiAccessToken;
          }
        } catch (err) {
          console.error(
            "[proxy.chat] rotated JWT decode failed (forwarding pre-refresh token, still valid):",
            err,
          );
        }
      }
    } catch (err) {
      console.error("[proxy.chat] session refresh self-fetch failed:", err);
      // Fall through with the pre-refresh token — RPI still accepts it
      // until actual expiry. Browser's next session-poll will catch up.
    }
  }

  // Step 3 — forward to apps/server. Stream the request body with duplex:
  // "half" so the upstream sees chunks as they arrive (the chat endpoint is
  // request → SSE response, but the body itself is a single JSON payload;
  // streaming the body is mostly future-proofing).
  const headers: Record<string, string> = {
    "Content-Type": request.headers.get("content-type") ?? "application/json",
  };
  // App-identity Bearer (apiKey) — preserved from the inbound request.
  // Browser still attaches this through the chat-panel headers callback.
  const inboundAuth = request.headers.get("authorization");
  if (inboundAuth) headers["Authorization"] = inboundAuth;
  // Per-user RPI token — read from the rotated JWT, attached as X-RPI-Token
  // matching the contract apps/server already understands.
  if (accessToken) headers["X-RPI-Token"] = accessToken;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_URL}/api/v1/workspaces/${workspaceId}/chat`,
      {
        method: "POST",
        headers,
        body: request.body,
        // @ts-expect-error duplex is required by undici/Bun for streamed bodies
        // but isn't in the TS lib.dom fetch RequestInit type yet.
        duplex: "half",
        signal: request.signal,
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `Upstream apps/server unreachable: ${err instanceof Error ? err.message : String(err)}`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Step 4 — pipe the upstream Response back to the browser. The body is a
  // ReadableStream (SSE chunks for the AG-UI stream); Next.js App Router
  // forwards it through without buffering. Preserve content-type + any other
  // upstream response headers, then append every rotated Set-Cookie chunk so
  // the browser receives a complete, in-sync session cookie even when the
  // JWT exceeds the single-cookie size limit.
  const response = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
  for (const cookie of rotatedCookies) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
