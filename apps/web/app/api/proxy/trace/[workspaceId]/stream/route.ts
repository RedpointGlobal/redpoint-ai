/**
 * GET /api/proxy/trace/[workspaceId]/stream — same-origin auth-forwarding proxy
 * for the rich-telemetry SSE trace stream that drives the info panel's Traffic tab.
 *
 * Why a proxy: the browser EventSource that reads this stream cannot set an
 * Authorization header, so under AUTH_REQUIRED=true a DIRECT EventSource to the
 * gated apps/server /api/v1/.../trace/stream 401s and the panel shows only
 * frontend lifecycle events (no server-side token/tool telemetry). This
 * same-origin proxy reads the HttpOnly session cookie server-side, injects the
 * session credential via buildForwardHeaders (X-RPI-Token / X-RPI-URL / apiKey),
 * and pipes the upstream SSE ReadableStream through UNBUFFERED — mirroring the
 * chat proxy. (Same-origin, so the browser sends the session cookie for us.)
 *
 * NOTE: this does NOT exempt /trace from the auth gate — it carries per-user
 * token counts, so the credential injection is the point.
 */
import { buildForwardHeaders } from "@/lib/server-forward";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

// Long-lived SSE — never statically optimized.
export const dynamic = "force-dynamic";

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
      `${API_URL}/api/v1/workspaces/${workspaceId}/trace/stream`,
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

  // Pipe the SSE stream through unbuffered (upstream.body is a ReadableStream);
  // preserve Content-Type: text/event-stream and any other upstream headers.
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
