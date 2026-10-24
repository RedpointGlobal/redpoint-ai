/**
 * The new safety bounds (constants): a per-request timeout and a response-size
 * cap on every RPI request, and a bounded folder walk. Everything inside them
 * behaves exactly as before.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boundedFetch, UPSTREAM_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "../client/upstream-limits.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerFolderTools, FOLDER_WALK_LIMITS, folderWalkNote } from "../tools/folders.js";
import { folderCache } from "../client/folder-cache.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("boundedFetch", () => {
  it("pinned limits: 60 s per request, 16 MiB per response", () => {
    expect([UPSTREAM_TIMEOUT_MS, MAX_RESPONSE_BYTES]).toEqual([60_000, 16 * 1024 * 1024]);
  });
  it("a request past the timeout → a clean 'timed out' error", async () => {
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    await expect(boundedFetch("https://x.test/a", {}, "RPI API request", { timeoutMs: 30, maxBytes: 1000 })).rejects.toThrow("RPI API request timed out after 0.03s");
  });
  it("the caller's own abort is not reported as a timeout", async () => {
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = boundedFetch("https://x.test/a", { signal: ac.signal }, "RPI API request", { timeoutMs: 5000, maxBytes: 1000 });
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
  });
  it("a body over the cap — declared or streamed — → a clean 'exceeded' error", async () => {
    globalThis.fetch = (async () => new Response("x".repeat(50), { headers: { "content-length": "50" } })) as unknown as typeof fetch;
    const declared = await boundedFetch("https://x.test/a", {}, "RPI API request", { timeoutMs: 1000, maxBytes: 10 });
    await expect(declared.text()).rejects.toThrow("RPI API request response exceeded 10 bytes");
    globalThis.fetch = (async () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("y".repeat(8))); c.enqueue(new TextEncoder().encode("y".repeat(8))); c.close(); } }))) as unknown as typeof fetch;
    const streamed = await boundedFetch("https://x.test/a", {}, "RPI API request", { timeoutMs: 1000, maxBytes: 10 });
    await expect(streamed.text()).rejects.toThrow("RPI API request response exceeded 10 bytes");
  });
  it("within the bounds → the body, unchanged", async () => {
    globalThis.fetch = (async () => new Response('{"a":1}')) as unknown as typeof fetch;
    expect(await (await boundedFetch("https://x.test/a", {})).text()).toBe('{"a":1}');
  });
});

describe("RPIApiClient through the bounds", () => {
  const client = new RPIApiClient("https://rpi.example.test", new RPIAuthService("https://rpi.example.test", "i", "s"), "t-1");
  it("GET: a JSON body as before; a non-2xx → the same RpiApiError", async () => {
    globalThis.fetch = (async () => new Response('{"ok":true}')) as unknown as typeof fetch;
    expect(await client.get("tok", "/x", undefined, { baseUrl: undefined, verbose: true })).toEqual({ ok: true });
    globalThis.fetch = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    await expect(client.get("tok", "/x", undefined, { baseUrl: undefined })).rejects.toThrow("RPI API error");
  });
  it("DELETE: no body read; a non-2xx still throws", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await client.delete("tok", "/x", { baseUrl: undefined })).toBeUndefined();
  });
});

describe("the folder walk is bounded", () => {
  const saved = { ...FOLDER_WALK_LIMITS };
  afterEach(() => Object.assign(FOLDER_WALK_LIMITS, saved));
  const call = async (server: McpServer) => {
    const handler = (server.server as unknown as { _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<unknown>> })._requestHandlers.get("tools/call")!;
    return (await handler(
      { method: "tools/call", params: { name: "list_folders", arguments: {} } },
      { signal: new AbortController().signal, sendRequest: () => Promise.resolve({}), authInfo: { token: "tok-bound-" + Math.random(), clientId: "t", scopes: [] } },
    )) as { content: Array<{ text: string }> };
  };
  function harness() {
    const server = new McpServer({ name: "t", version: "0" });
    registerFolderTools(server, new RPIApiClient("https://rpi.example.test", new RPIAuthService("https://rpi.example.test", "i", "s"), "t-1"));
    return server;
  }
  // A tree where every folder has two children (and one child that repeats its parent — a cycle).
  const tree = () =>
    mock(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/root-folders")) return Response.json({ folders: [{ id: "r", name: "root" }] });
      const id = u.searchParams.get("ID")!;
      return Response.json({ folders: [{ id: `${id}.a`, name: `${id}.a` }, { id: `${id}.b`, name: `${id}.b` }, { id, name: "cycle" }] });
    });
  it("past maxFolders → stops, the list is partial, a note says so (first block still the JSON list)", async () => {
    folderCache.clear?.();
    FOLDER_WALK_LIMITS.maxFolders = 5;
    globalThis.fetch = tree() as unknown as typeof fetch;
    const r = await call(harness());
    expect(JSON.parse(r.content[0]!.text)).toHaveLength(5);
    expect(r.content[1]!.text).toBe(folderWalkNote("more than 5 folders"));
  });
  it("past maxDepth → stops with its note; a repeated folder (a cycle) is never walked twice", async () => {
    FOLDER_WALK_LIMITS.maxDepth = 3;
    const f = tree();
    globalThis.fetch = f as unknown as typeof fetch;
    const r = await call(harness());
    expect(r.content[1]!.text).toBe(folderWalkNote("deeper than 3 levels"));
    const walkedIds = f.mock.calls.map(([u]) => new URL(u as string).searchParams.get("ID")).filter(Boolean);
    expect(new Set(walkedIds).size).toBe(walkedIds.length);
  });
  it("a small tree → exactly as before: one JSON block, no note", async () => {
    globalThis.fetch = (async (url: string) =>
      new URL(url).pathname.endsWith("/root-folders") ? Response.json({ folders: [{ id: "r", name: "root" }] }) : Response.json({ folders: [] })) as unknown as typeof fetch;
    const r = await call(harness());
    expect(r.content).toHaveLength(1);
    expect(JSON.parse(r.content[0]!.text)).toHaveLength(1);
  });
});
