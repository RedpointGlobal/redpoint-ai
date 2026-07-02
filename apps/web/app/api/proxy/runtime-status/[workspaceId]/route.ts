/**
 * GET /api/proxy/runtime-status/[workspaceId] — server-side proxy.
 *
 * Mirrors the chat proxy's auth flow (see
 * `apps/web/app/api/proxy/chat/[workspaceId]/route.ts` for the full rationale)
 * but for the read-only runtime-status endpoint that drives the info panel's
 * Auth label. No streaming — single JSON response.
 *
 * Why a proxy: cookie-only RPI token storage. Browser doesn't see the
 * access_token anymore; this proxy reads it from the (possibly chunked)
 * NextAuth cookie server-side and attaches it as `X-RPI-Token` to apps/server,
 * which flips the per-server Auth label from "none" to "authenticated" (see
 * `apps/server/src/routes/workspaces.ts:259-271`).
 *
 * Refresh-trigger optimization: only self-fetch /api/auth/session (which
 * fires callbacks.jwt → may rotate the cookie) when the inbound token is
 * near expiry. Most calls skip the ~110-150ms loopback hop and run fast.
 */

import { getToken } from "next-auth/jwt";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
const COOKIE_NAME = "authjs.session-token";
const REFRESH_TRIGGER_MARGIN_MS = 60_000;

interface JwtPayload {
  rpiAccessToken?: string;
  rpiExpiresAt?: number;
  [key: string]: unknown;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await ctx.params;

  // Read the access_token + expiry from the inbound JWT (handles chunking).
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
      console.error("[proxy.runtime-status] inbound JWT decode failed:", err);
    }
  }

  // Refresh-window self-fetch only when needed (rare path, ~hourly).
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
      rotatedCookies = sessionResponse.headers.getSetCookie();
      if (rotatedCookies.length > 0 && process.env.AUTH_SECRET) {
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
            "[proxy.runtime-status] rotated JWT decode failed (forwarding pre-refresh token):",
            err,
          );
        }
      }
    } catch (err) {
      console.error(
        "[proxy.runtime-status] session refresh self-fetch failed:",
        err,
      );
    }
  }

  const headers: Record<string, string> = {};
  const inboundAuth = request.headers.get("authorization");
  if (inboundAuth) headers["Authorization"] = inboundAuth;
  if (accessToken) headers["X-RPI-Token"] = accessToken;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_URL}/api/v1/workspaces/${workspaceId}/runtime-status`,
      { method: "GET", headers, signal: request.signal },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `Upstream apps/server unreachable: ${err instanceof Error ? err.message : String(err)}`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

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
