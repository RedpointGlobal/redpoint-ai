/**
 * GET /api/proxy/workspaces/[id]/tools — server-side auth-forwarding proxy for
 * the workspace tool list (Tools tab in the info panel).
 *
 * Identical auth flow to /api/proxy/workspaces/[id] (see that file and
 * lib/server-forward.ts); only the upstream path differs. Kept as a separate
 * route because apps/server exposes tools under /workspaces/:id/tools.
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
    upstream = await fetch(`${API_URL}/api/v1/workspaces/${id}/tools`, {
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
