/**
 * The proxy routes put the workspace id into an apps/server URL. Next hands them the
 * param decoded, so an id like "../../../metrics" (sent as ..%2F..%2F..%2Fmetrics)
 * or "x?" would step out of /api/v1/workspaces/<id>/… to any server route. Each
 * proxy refuses such an id with a 400 before any upstream call; a UUID goes to
 * exactly its own path.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { GET as workspaceGET } from "@/app/api/proxy/workspaces/[id]/route";
import { GET as toolsGET } from "@/app/api/proxy/workspaces/[id]/tools/route";
import { GET as runtimeStatusGET } from "@/app/api/proxy/runtime-status/[workspaceId]/route";
import { GET as traceGET } from "@/app/api/proxy/trace/[workspaceId]/route";
import { GET as traceStreamGET } from "@/app/api/proxy/trace/[workspaceId]/stream/route";
import { POST as chatPOST } from "@/app/api/proxy/chat/[workspaceId]/route";
import { isWorkspaceId } from "@/lib/workspace-id";

const UUID = "4cb15d40-c849-4e1d-afe3-618fa6676aa0";
const API = new URL(process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000");
const ESCAPES = ["..", "../../../metrics", "../../../api/v1/health", "%2E%2E", "x?", "a/b", "a.b", "", "a".repeat(129)];

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: { name: string; handler: Handler; param: string; method: string; suffix: string }[] = [
  { name: "workspaces/[id]", handler: workspaceGET as Handler, param: "id", method: "GET", suffix: "" },
  { name: "workspaces/[id]/tools", handler: toolsGET as Handler, param: "id", method: "GET", suffix: "/tools" },
  { name: "runtime-status/[workspaceId]", handler: runtimeStatusGET as Handler, param: "workspaceId", method: "GET", suffix: "/runtime-status" },
  { name: "trace/[workspaceId]", handler: traceGET as Handler, param: "workspaceId", method: "GET", suffix: "/trace" },
  { name: "trace/[workspaceId]/stream", handler: traceStreamGET as Handler, param: "workspaceId", method: "GET", suffix: "/trace/stream" },
  { name: "chat/[workspaceId]", handler: chatPOST as Handler, param: "workspaceId", method: "POST", suffix: "/chat" },
];

const realFetch = globalThis.fetch;
let calls: string[] = [];
function recordFetches() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

function call(route: (typeof ROUTES)[number], id: string): Promise<Response> {
  const init: RequestInit = route.method === "POST" ? { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } } : {};
  return route.handler(new Request("http://localhost:3001/api/proxy/x", init), { params: Promise.resolve({ [route.param]: id }) });
}

describe("a workspace id", () => {
  it("is a UUID-shaped token: no dot, slash, query, percent or empty", () => {
    expect(isWorkspaceId(UUID)).toBe(true);
    for (const id of ESCAPES) expect(isWorkspaceId(id)).toBe(false);
  });

  it("needs refusing, not just encoding: an encoded '..' is still a dot segment", () => {
    expect(new URL(`http://s/api/v1/workspaces/${encodeURIComponent("..")}/trace`).pathname).toBe("/api/v1/trace");
  });
});

describe("each proxy route", () => {
  for (const route of ROUTES) {
    it(`${route.name} refuses an escaping id with a 400 and calls no upstream`, async () => {
      recordFetches();
      for (const id of ESCAPES) {
        const res = await call(route, id);
        expect(res.status).toBe(400);
      }
      expect(calls).toEqual([]);
    });

    it(`${route.name} sends a UUID to exactly its own server path`, async () => {
      recordFetches();
      await call(route, UUID);
      const upstream = calls.map((u) => new URL(u)).filter((u) => u.origin === API.origin);
      expect(upstream.map((u) => u.pathname)).toEqual([`/api/v1/workspaces/${UUID}${route.suffix}`]);
    });
  }
});
