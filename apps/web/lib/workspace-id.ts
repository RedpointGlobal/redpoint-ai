/**
 * The workspace id a proxy route puts into an apps/server URL. Next hands a route
 * its param DECODED, so "..%2F..%2Fmetrics" arrives as "../../metrics" and a "%3F"
 * as "?": interpolated, either one steps out of /api/v1/workspaces/<id>/… to any
 * server route. Encoding is not enough ("..", or its encoded form, is still a dot
 * segment the URL parser resolves). Ids are UUIDs, so a proxy accepts only
 * [A-Za-z0-9_-] and refuses anything else before any upstream call.
 */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isWorkspaceId(id: string): boolean {
  return WORKSPACE_ID.test(id);
}

export function invalidWorkspaceId(): Response {
  return new Response(JSON.stringify({ error: "Invalid workspace id" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
