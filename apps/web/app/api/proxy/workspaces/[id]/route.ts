/**
 * GET /api/proxy/workspaces/[id] — server-side auth-forwarding proxy for the
 * workspace-metadata read (name, config, suggestions).
 *
 * Mirrors the runtime-status proxy
 * (apps/web/app/api/proxy/runtime-status/[workspaceId]/route.ts): reads the
 * HttpOnly NextAuth cookie server-side, attaches the session's credential to
 * the gated apps/server request, and appends any rotated session cookie to the
 * response. The raw RPI/app token never reaches browser JS.
 *
 * Client callers (workspace/[id]/page.tsx, info-panel Config tab) fetch this
 * same-origin path so the browser sends the session cookie automatically.
 */

import { buildForwardHeaders } from "@/lib/server-forward";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const origin = new URL(request.url).origin;

  const { headers: forward, rotatedCookies } = await buildForwardHeaders(
    cookieHeader,
    origin,
  );

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/api/v1/workspaces/${id}`, {
      method: "GET",
      headers: forward,
      signal: request.signal,
    });
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
