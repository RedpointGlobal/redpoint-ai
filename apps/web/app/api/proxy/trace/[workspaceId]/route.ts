/**
 * GET /api/proxy/trace/[workspaceId] — same-origin auth-forwarding proxy for the
 * trace buffer read/clear endpoint (the info panel clears the server-side buffer
 * once per page load via ?clear=1). Same rationale as the /stream sibling: a
 * direct browser fetch to the gated apps/server /trace 401s under
 * AUTH_REQUIRED=true; this injects the session credential server-side. Forwards
 * the query string (?clear=1) verbatim.
 */
import { buildForwardHeaders } from "@/lib/server-forward";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await ctx.params;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const url = new URL(request.url);
  const origin = url.origin;

  const { headers: forward, rotatedCookies } = await buildForwardHeaders(
    cookieHeader,
    origin,
  );

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_URL}/api/v1/workspaces/${workspaceId}/trace${url.search}`,
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
