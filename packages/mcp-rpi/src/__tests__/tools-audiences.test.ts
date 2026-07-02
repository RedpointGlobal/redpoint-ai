/**
 * Unit tests for the rewritten audiences tools. Verifies each tool hits the
 * correct RPI path, passes the expected query/body, and wires the X-ClientID
 * header from either a per-call override or the RPIApiClient default.
 *
 * Mocks `fetch` directly (consistent with other tests in this package).
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerAudienceTools } from "../tools/audiences.js";

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
  registerAudienceTools(server, api);
  return { server };
}

describe("audiences tools", () => {
  afterEach(() => restoreFetch());

  // -------------------------------------------------------------------------
  // list_audiences — POST /client/file-system/search-file-infos
  // -------------------------------------------------------------------------
  describe("list_audiences", () => {
    it("POSTs to search-file-infos with fileTypeFilters=['Audience']", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_audiences", { pageNumber: 1, pageSize: 20 });

      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/file-system/search-file-infos",
      );
      const body = JSON.parse(capturedBody);
      expect(body.fileTypeFilters).toEqual(["Audience"]);
      expect(body.pageNumber).toBe(1);
      expect(body.pageSize).toBe(20);
    });

    it("returns card shape {id, name, description, parentFolderName} by default", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            {
              id: "a1",
              name: "Audience 1",
              description: "desc",
              parentFolderName: "Q1",
              subTypeName: "Campaign",
              dateModified: "2026-01-01",
              extra: "noise",
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_audiences", {
        pageNumber: 1,
        pageSize: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0]).toEqual({
        id: "a1",
        name: "Audience 1",
        description: "desc",
        parentFolderName: "Q1",
      });
      // subTypeName, dateModified, extra should NOT be present
      expect(parsed.results[0].subTypeName).toBeUndefined();
      expect(parsed.results[0].dateModified).toBeUndefined();
      expect(parsed.results[0].extra).toBeUndefined();
    });

    it("returns full RPI response when verbose=true", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            { id: "a1", name: "A", description: "d", extra: "keepme" },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_audiences", {
        pageNumber: 1,
        pageSize: 20,
        verbose: true,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0].extra).toBe("keepme");
    });

    it("passes nameFilter through as searchString (default '*' when omitted)", async () => {
      let capturedBody = "";
      stubFetch(async (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_audiences", {
        pageNumber: 1,
        pageSize: 20,
        nameFilter: "holiday",
      });
      expect(JSON.parse(capturedBody).searchString).toBe("holiday");
    });

    it("uses defaultClientId in X-ClientID when no override is passed", async () => {
      let headers: Record<string, string> = {};
      stubFetch(async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness("tenant-default");
      await invokeTool(server, "list_audiences", { pageNumber: 1, pageSize: 20 });
      expect(headers["X-ClientID"]).toBe("tenant-default");
    });

    it("uses per-call clientId override for X-ClientID", async () => {
      let headers: Record<string, string> = {};
      stubFetch(async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness("tenant-default");
      await invokeTool(server, "list_audiences", {
        pageNumber: 1,
        pageSize: 20,
        clientId: "tenant-override",
      });
      expect(headers["X-ClientID"]).toBe("tenant-override");
    });
  });

  // -------------------------------------------------------------------------
  // get_audience_by_id — GET /client/files/audience?ID=...
  // -------------------------------------------------------------------------
  describe("get_audience_by_id", () => {
    it("GETs the audience endpoint with ID query param", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ id: "aud-1", name: "Test" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_audience_by_id", { audienceId: "aud-1" });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/audience?ID=aud-1",
      );
    });

    it("strips verbose fields from the response by default", async () => {
      stubFetch(() =>
        jsonResponse({ $jsonType: "Aud", id: "aud-1", name: "Test" }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_by_id", {
        audienceId: "aud-1",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.$jsonType).toBeUndefined();
      expect(parsed.name).toBe("Test");
    });
  });

  // -------------------------------------------------------------------------
  // get_audience_by_name
  // -------------------------------------------------------------------------
  describe("get_audience_by_name", () => {
    it("POSTs search-file-infos and returns a single-entry matches[] with fullPath for one exact CI-name hit", async () => {
      stubFetch(async (url) => {
        if (url.toString().includes("search-file-infos")) {
          return jsonResponse({
            results: [
              { id: "a1", name: "Other" },
              { id: "a2", name: "Holiday-US" },
            ],
          });
        }
        // file-info enrichment lookup by ID
        const id = new URL(url).searchParams.get("ID");
        return jsonResponse({
          id,
          fullPath: id === "a2" ? "\\Holidays\\Holiday-US" : "",
        });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_by_name", {
        name: "HOLIDAY-US",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.matches).toHaveLength(1);
      expect(parsed.matches[0].id).toBe("a2");
      expect(parsed.matches[0].fullPath).toBe("\\Holidays\\Holiday-US");
    });

    it("returns ALL matches with fullPath when multiple share the exact name (different folders)", async () => {
      const PATHS: Record<string, string> = {
        a1: "\\Marketing\\Active\\MA Residents",
        a2: "\\Archive\\2024\\MA Residents",
      };
      stubFetch(async (url) => {
        if (url.toString().includes("search-file-infos")) {
          return jsonResponse({
            results: [
              { id: "a1", name: "MA Residents", parentFolderName: "Active" },
              { id: "a2", name: "MA Residents", parentFolderName: "2024" },
              { id: "a3", name: "MA Residents (Golden)" },
            ],
          });
        }
        const id = new URL(url).searchParams.get("ID");
        return jsonResponse({ id, fullPath: PATHS[id!] ?? "" });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_by_name", {
        name: "MA Residents",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.matches).toHaveLength(2);
      const ids = parsed.matches.map((m: { id: string }) => m.id).sort();
      expect(ids).toEqual(["a1", "a2"]);
      // Full paths resolved per match so the LLM can disambiguate.
      const paths = parsed.matches
        .map((m: { fullPath: string }) => m.fullPath)
        .sort();
      expect(paths).toEqual([
        "\\Archive\\2024\\MA Residents",
        "\\Marketing\\Active\\MA Residents",
      ]);
    });

    it("returns found=false when no match (no file-info enrichment)", async () => {
      stubFetch(async () => jsonResponse({ results: [] }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_by_name", {
        name: "does-not-exist",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(false);
      expect(parsed.matches).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // get_audience_metadata — GET /client/files/audience/metadata?ID=...
  // -------------------------------------------------------------------------
  describe("get_audience_metadata", () => {
    it("GETs the metadata endpoint with ID query param", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ items: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_audience_metadata", { audienceId: "aud-1" });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/audience/metadata?ID=aud-1",
      );
    });
  });

  // -------------------------------------------------------------------------
  // list_audience_definitions — GET /client/configuration/audience-definitions
  // -------------------------------------------------------------------------
  describe("list_audience_definitions", () => {
    it("GETs the audience-definitions endpoint (no query)", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ objects: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_audience_definitions", {
        pageNumber: 1,
        pageSize: 20,
      });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/configuration/audience-definitions",
      );
    });

    it("filters by nameFilter (CI substring) client-side", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            { id: "1", name: "Basic Customer" },
            { id: "2", name: "VIP Customer" },
            { id: "3", name: "Leads" },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_audience_definitions", {
        pageNumber: 1,
        pageSize: 20,
        nameFilter: "CUSTOMER",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalCount).toBe(2);
      expect(parsed.results.map((r: any) => r.id).sort()).toEqual(["1", "2"]);
    });

    it("returns card shape {id, name, description} by default (strips oversize fields)", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            {
              id: "1",
              name: "Def1",
              description: "d1",
              offerHistoryAttributes: [{ big: "data" }],
              trainingSets: [{ a: 1 }],
              metadata: { items: Array(100).fill({}), count: 100 },
              otherField: "noise",
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_audience_definitions", {
        pageNumber: 1,
        pageSize: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0]).toEqual({
        id: "1",
        name: "Def1",
        description: "d1",
      });
      expect(parsed.results[0].offerHistoryAttributes).toBeUndefined();
      expect(parsed.results[0].trainingSets).toBeUndefined();
      expect(parsed.results[0].metadata).toBeUndefined();
    });

    it("returns full response when verbose=true", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            {
              id: "1",
              name: "Def1",
              offerHistoryAttributes: [{ kept: true }],
              trainingSets: [{ a: 1 }],
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_audience_definitions", {
        pageNumber: 1,
        pageSize: 20,
        verbose: true,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0].offerHistoryAttributes).toEqual([{ kept: true }]);
      expect(parsed.results[0].trainingSets).toEqual([{ a: 1 }]);
    });

    it("paginates client-side (pageNumber=2, pageSize=5 slices items 6-10)", async () => {
      const objects = Array.from({ length: 12 }, (_, i) => ({
        id: String(i + 1),
        name: `Def${i + 1}`,
      }));
      stubFetch(() => jsonResponse({ objects }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_audience_definitions", {
        pageNumber: 2,
        pageSize: 5,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalCount).toBe(12);
      expect(parsed.results.map((r: any) => r.id)).toEqual([
        "6",
        "7",
        "8",
        "9",
        "10",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // get_audience_definition_by_id / by_name
  // -------------------------------------------------------------------------
  describe("get_audience_definition_by_id", () => {
    it("finds by case-insensitive id equals", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            { id: "abc-123", name: "First" },
            { id: "DEF-456", name: "Second" },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_definition_by_id", {
        audienceDefinitionId: "def-456",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.match.name).toBe("Second");
    });

    it("returns found=false when no id matches", async () => {
      stubFetch(() =>
        jsonResponse({ objects: [{ id: "abc", name: "Only" }] }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_definition_by_id", {
        audienceDefinitionId: "missing",
      });
      expect(JSON.parse(result.content[0].text).found).toBe(false);
    });

    it("strips oversize fields from the match by default", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            {
              id: "def-1",
              name: "X",
              description: "d",
              offerHistoryAttributes: [{ a: 1 }],
              trainingSets: [{ b: 2 }],
              metadata: { items: [1, 2, 3], keep: "me" },
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_definition_by_id", {
        audienceDefinitionId: "def-1",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.match.id).toBe("def-1");
      expect(parsed.match.offerHistoryAttributes).toBeUndefined();
      expect(parsed.match.trainingSets).toBeUndefined();
      // metadata container kept; items stripped from inside it
      expect(parsed.match.metadata).toEqual({ keep: "me" });
    });

    it("preserves oversize fields when verbose=true", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            {
              id: "def-1",
              name: "X",
              offerHistoryAttributes: [{ a: 1 }],
              trainingSets: [{ b: 2 }],
              metadata: { items: [1, 2, 3] },
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_definition_by_id", {
        audienceDefinitionId: "def-1",
        verbose: true,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.match.offerHistoryAttributes).toEqual([{ a: 1 }]);
      expect(parsed.match.trainingSets).toEqual([{ b: 2 }]);
      expect(parsed.match.metadata.items).toEqual([1, 2, 3]);
    });
  });

  describe("get_audience_definition_by_name", () => {
    it("finds by case-insensitive name equals", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            { id: "1", name: "Customer Profile" },
            { id: "2", name: "Lead Score" },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_definition_by_name", {
        name: "CUSTOMER PROFILE",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.match.id).toBe("1");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("returns isError=true on non-2xx response", async () => {
      stubFetch(() => new Response("boom", { status: 500 }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_audience_by_id", {
        audienceId: "aud-1",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });
});
