/**
 * GET /api/proxy/runtime-status/[workspaceId] — server-side auth-forwarding
 * proxy for the read-only runtime-status endpoint that drives the info panel's
 * Config tab.
 *
 * Why a proxy: cookie-only token storage. The browser never sees the RPI/app
 * token; this proxy reads it from the HttpOnly NextAuth cookie server-side and
 * attaches the session's credential to the gated apps/server request.
 *
 * Uses the shared lib/server-forward helper so it forwards WHICHEVER credential
 * the session carries — rpiAccessToken → X-RPI-Token, apiKey → Authorization:
 * Bearer (fixed precedence) — and handles the near-expiry refresh race. The
 * earlier hand-rolled version only forwarded X-RPI-Token, so an apiKey-only
 * session (the /login gate identity) 401'd here under AUTH_REQUIRED=true; the
 * shared helper closes that.
 */

import { buildForwardHeaders } from "@/lib/server-forward";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await ctx.params;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const origin = new URL(request.url).origin;

  const { headers: forward, rotatedCookies } = await buildForwardHeaders(
    cookieHeader,
    origin,
  );

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_URL}/api/v1/workspaces/${workspaceId}/runtime-status`,
      { method: "GET", headers: forward, signal: request.signal },
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
