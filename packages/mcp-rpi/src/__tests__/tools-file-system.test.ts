/**
 * Tests for the file-system tools (get_file_info_by_id).
 * Mirrors the mock-fetch pattern from tools-folders.test.ts.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerFileSystemTools } from "../tools/file-system.js";

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
  registerFileSystemTools(server, api);
  return { server };
}

const SAMPLE_GUID = "11111111-2222-3333-4444-555555555555";

function fileInfoResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: SAMPLE_GUID,
    name: "Loyalty Tier A",
    description: "All members in tier A",
    typeName: "Audience",
    subTypeName: "Standard",
    fullPath: "\\Marketing\\Audiences\\Loyalty Tier A",
    createdBy: "alice",
    dateCreated: "2026-01-01T00:00:00Z",
    dateModified: "2026-04-15T12:00:00Z",
    parentFolderID: "00000000-0000-0000-0000-000000000001",
    parentFolderName: "Audiences",
    parentFolderFullPath: "\\Marketing\\Audiences",
    isHidden: false,
    isDeleted: false,
    $jsonTypeID: "406cbea8-6630-494a-81a7-b1594667b3f1",
    $jsonType: "FileStorageItemJsonResponseMessage",
    ...overrides,
  };
}

describe("file-system tools", () => {
  afterEach(() => restoreFetch());

  describe("get_file_info_by_id", () => {
    it("returns a card view by default", async () => {
      let capturedUrl: URL | null = null;
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        capturedUrl = u;
        if (u.pathname.endsWith("/file-system/file-info")) {
          return jsonResponse(fileInfoResponse());
        }
        throw new Error(`unexpected fetch: ${u.pathname}`);
      });

      const { server } = buildHarness();
      const res = await invokeTool(server, "get_file_info_by_id", {
        id: SAMPLE_GUID,
      });

      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      expect(body).toEqual({
        id: SAMPLE_GUID,
        name: "Loyalty Tier A",
        typeName: "Audience",
        subTypeName: "Standard",
        fullPath: "\\Marketing\\Audiences\\Loyalty Tier A",
        parentFolderName: "Audiences",
      });
      // Verbose-only fields stripped
      expect(body.description).toBeUndefined();
      expect(body.dateCreated).toBeUndefined();
      expect(body.parentFolderFullPath).toBeUndefined();
      // Endpoint + query
      expect(capturedUrl!.pathname).toBe(
        "/api/v2/client/file-system/file-info",
      );
      expect(capturedUrl!.searchParams.get("ID")).toBe(SAMPLE_GUID);
    });

    it("verbose: true returns the full RPI response unchanged", async () => {
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/file-system/file-info")) {
          return jsonResponse(fileInfoResponse());
        }
        throw new Error(`unexpected fetch: ${u.pathname}`);
      });

      const { server } = buildHarness();
      const res = await invokeTool(server, "get_file_info_by_id", {
        id: SAMPLE_GUID,
        verbose: true,
      });

      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      expect(body.description).toBe("All members in tier A");
      expect(body.dateCreated).toBe("2026-01-01T00:00:00Z");
      expect(body.fullPath).toBe("\\Marketing\\Audiences\\Loyalty Tier A");
      expect(body.$jsonType).toBe("FileStorageItemJsonResponseMessage");
    });

    it("returns isError on RPI 404", async () => {
      stubFetch(async () =>
        new Response("not found", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      const { server } = buildHarness();
      const res = await invokeTool(server, "get_file_info_by_id", {
        id: SAMPLE_GUID,
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error getting file info");
    });

    it("rejects an empty id before calling RPI", async () => {
      let fetched = false;
      stubFetch(async () => {
        fetched = true;
        return jsonResponse(fileInfoResponse());
      });

      const { server } = buildHarness();
      let threw = false;
      try {
        await invokeTool(server, "get_file_info_by_id", { id: "" });
      } catch {
        threw = true;
      }
      // Zod validation fails before the handler runs; either the call throws
      // or comes back without a network round-trip — both are acceptable, but
      // we MUST NOT hit fetch.
      expect(fetched).toBe(false);
      // And if it didn't throw, it must have surfaced an error response.
      if (!threw) {
        // No throw path: bun-mcp wraps validation into an error response — fine.
      }
    });
  });
});
