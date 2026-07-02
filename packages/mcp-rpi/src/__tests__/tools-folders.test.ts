/**
 * Tests for the folder tools (list_folders, create_folder).
 * Mirrors the mock-fetch pattern from tools-audiences-run.test.ts.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerFolderTools } from "../tools/folders.js";
import { folderCache } from "../client/folder-cache.js";

const originalFetch = globalThis.fetch;
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = mock(handler as any) as any;
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function invokeTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<
        string,
        (req: unknown, extra: unknown) => Promise<unknown>
      >;
    }
  )._requestHandlers;
  const handler = handlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler not registered");
  return handler(
    { method: "tools/call", params: { name, arguments: args } },
    {
      signal: new AbortController().signal,
      sendRequest: () => Promise.resolve({}),
      authInfo: { token: "user-token", clientId: "test", scopes: [] },
    },
  ) as any;
}

function buildHarness(defaultClientId = "tenant-default") {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const auth = new RPIAuthService(
    "https://rpi.example.com",
    "oauth-id",
    "oauth-secret",
    "proxy",
    "proxy-pass",
  );
  const api = new RPIApiClient(
    "https://rpi.example.com",
    auth,
    defaultClientId,
  );
  registerFolderTools(server, api);
  return { server };
}

function folder(
  id: string,
  name: string,
  parentId: string | null = null,
  fullPath?: string,
) {
  return {
    id,
    name,
    fullPath: fullPath ?? (parentId ? `${parentId}/${name}` : `\\${name}`),
    parentFolderID: parentId ?? "00000000-0000-0000-0000-000000000000",
    description: null,
    isRootFolder: parentId === null,
  };
}

describe("folder tools", () => {
  beforeEach(() => folderCache.clear());
  afterEach(() => {
    restoreFetch();
    folderCache.clear();
  });

  describe("list_folders", () => {
    it("walks root + subfolders and returns flat nodes", async () => {
      const calls: string[] = [];
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        calls.push(u.pathname + u.search);
        if (u.pathname.endsWith("/folders/root-folders")) {
          return jsonResponse({
            folders: [folder("root-1", "Marketing"), folder("root-2", "Ops")],
          });
        }
        if (u.pathname.endsWith("/folders/subfolders")) {
          const id = u.searchParams.get("ID");
          if (id === "root-1") {
            return jsonResponse({
              folders: [folder("c1", "Campaigns", "root-1")],
            });
          }
          if (id === "c1") {
            return jsonResponse({
              folders: [folder("g1", "Q1", "c1")],
            });
          }
          return jsonResponse({ folders: [] });
        }
        throw new Error(`unexpected fetch: ${u.pathname}`);
      });

      const { server } = buildHarness();
      const res = await invokeTool(server, "list_folders", {});
      expect(res.isError).toBeFalsy();
      const nodes = JSON.parse(res.content[0].text);
      expect(nodes).toHaveLength(4);
      const names = nodes.map((n: { name: string }) => n.name).sort();
      expect(names).toEqual(["Campaigns", "Marketing", "Ops", "Q1"]);
      const campaigns = nodes.find((n: { name: string }) => n.name === "Campaigns");
      expect(campaigns.parentFolderId).toBe("root-1");
      const marketing = nodes.find((n: { name: string }) => n.name === "Marketing");
      expect(marketing.parentFolderId).toBeNull();
      // 1 root call + 4 subfolder calls (one per node, even leaves return [])
      expect(calls.filter((c) => c.includes("root-folders"))).toHaveLength(1);
      expect(calls.filter((c) => c.includes("subfolders"))).toHaveLength(4);
    });

    it("applies nameFilter as a case-insensitive substring match", async () => {
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/folders/root-folders")) {
          return jsonResponse({
            folders: [
              folder("a", "Marketing"),
              folder("b", "Sales"),
              folder("c", "Marketing-Archive"),
            ],
          });
        }
        return jsonResponse({ folders: [] });
      });
      const { server } = buildHarness();
      const res = await invokeTool(server, "list_folders", {
        nameFilter: "marketing",
      });
      const nodes = JSON.parse(res.content[0].text);
      expect(nodes.map((n: { name: string }) => n.name).sort()).toEqual([
        "Marketing",
        "Marketing-Archive",
      ]);
    });

    it("hits cache on second call (no second root-folders fetch)", async () => {
      const calls: string[] = [];
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        calls.push(u.pathname);
        if (u.pathname.endsWith("/folders/root-folders")) {
          return jsonResponse({ folders: [folder("r", "Root")] });
        }
        return jsonResponse({ folders: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_folders", {});
      const firstCallCount = calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      await invokeTool(server, "list_folders", {});
      expect(calls.length).toBe(firstCallCount);
    });

    it("verbose: true bypasses cache and returns raw RPI records", async () => {
      let rootCalls = 0;
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/folders/root-folders")) {
          rootCalls++;
          return jsonResponse({ folders: [folder("r", "Root")] });
        }
        return jsonResponse({ folders: [] });
      });
      const { server } = buildHarness();
      const res = await invokeTool(server, "list_folders", { verbose: true });
      expect(res.isError).toBeFalsy();
      const raw = JSON.parse(res.content[0].text);
      expect(raw[0]).toMatchObject({
        id: "r",
        name: "Root",
        isRootFolder: true,
      });
      // Re-call: verbose bypasses cache, root-folders fetched again
      await invokeTool(server, "list_folders", { verbose: true });
      expect(rootCalls).toBe(2);
    });

    it("returns isError on RPI 4xx", async () => {
      stubFetch(async () =>
        new Response("forbidden", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        }),
      );
      const { server } = buildHarness();
      const res = await invokeTool(server, "list_folders", {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error listing folders");
    });
  });

  describe("create_folder", () => {
    it("posts the body and returns the new folder id", async () => {
      const calls: Array<{ method: string; url: string; body?: string }> = [];
      stubFetch(async (url, init) => {
        const u = new URL(url.toString());
        calls.push({
          method: init?.method ?? "GET",
          url: u.pathname,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (u.pathname.endsWith("/file-system/folder")) {
          return jsonResponse({
            id: "new-folder-id",
            statusCode: "OK",
          });
        }
        throw new Error(`unexpected fetch: ${u.pathname}`);
      });
      const { server } = buildHarness();
      const res = await invokeTool(server, "create_folder", {
        name: "claude-test",
        description: "from unit test",
        parentFolderId: "parent-1",
      });
      expect(res.isError).toBeFalsy();
      const out = JSON.parse(res.content[0].text);
      expect(out).toEqual({ id: "new-folder-id" });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      const sentBody = JSON.parse(calls[0].body!);
      expect(sentBody).toEqual({
        name: "claude-test",
        description: "from unit test",
        parentFolderID: "parent-1",
      });
    });

    it("invalidates the cached folder tree for this user", async () => {
      let rootCalls = 0;
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/folders/root-folders")) {
          rootCalls++;
          return jsonResponse({ folders: [folder("r", "Root")] });
        }
        if (u.pathname.endsWith("/folders/subfolders")) {
          return jsonResponse({ folders: [] });
        }
        if (u.pathname.endsWith("/file-system/folder")) {
          return jsonResponse({ id: "new", statusCode: "OK" });
        }
        throw new Error(`unexpected fetch: ${u.pathname}`);
      });
      const { server } = buildHarness();
      // Prime cache
      await invokeTool(server, "list_folders", {});
      expect(rootCalls).toBe(1);
      await invokeTool(server, "list_folders", {});
      expect(rootCalls).toBe(1);
      // Mutate
      await invokeTool(server, "create_folder", { name: "x" });
      // Cache should now miss
      await invokeTool(server, "list_folders", {});
      expect(rootCalls).toBe(2);
    });

    it("returns isError on RPI 4xx", async () => {
      stubFetch(async () =>
        new Response("bad request", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        }),
      );
      const { server } = buildHarness();
      const res = await invokeTool(server, "create_folder", { name: "x" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error creating folder");
    });
  });
});
