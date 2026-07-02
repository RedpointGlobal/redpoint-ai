/**
 * Unit tests for the selection rules tools. Verifies each tool hits the
 * correct RPI path, that subTypeFilters passes through when provided, and
 * that the Basic vs Standard detail endpoints are distinct.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerSelectionRuleTools } from "../tools/selection-rules.js";

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

function buildHarness() {
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
    "tenant-default",
  );
  registerSelectionRuleTools(server, api);
  return { server };
}

describe("selection rules tools", () => {
  afterEach(() => restoreFetch());

  // -------------------------------------------------------------------------
  // list_selection_rules
  // -------------------------------------------------------------------------
  describe("list_selection_rules", () => {
    it("POSTs search-file-infos with fileTypeFilters=['Selection Rule']", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_selection_rules", {
        pageNumber: 1,
        pageSize: 20,
      });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/file-system/search-file-infos",
      );
      expect(JSON.parse(capturedBody).fileTypeFilters).toEqual([
        "Selection Rule",
      ]);
    });

    it("returns card shape {id, name, description, parentFolderName, subTypeName} by default", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            {
              id: "r1",
              name: "Segment A",
              description: "desc",
              parentFolderName: "Segments",
              subTypeName: "Basic",
              dateModified: "2026-01-01",
              extra: "noise",
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_selection_rules", {
        pageNumber: 1,
        pageSize: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0]).toEqual({
        id: "r1",
        name: "Segment A",
        description: "desc",
        parentFolderName: "Segments",
        subTypeName: "Basic",
      });
      expect(parsed.results[0].dateModified).toBeUndefined();
      expect(parsed.results[0].extra).toBeUndefined();
    });

    it("does not include subTypeFilters when subType is omitted", async () => {
      let capturedBody = "";
      stubFetch(async (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_selection_rules", {
        pageNumber: 1,
        pageSize: 20,
      });
      expect(JSON.parse(capturedBody).subTypeFilters).toBeUndefined();
    });

    it("passes subType='Basic' through as subTypeFilters", async () => {
      let capturedBody = "";
      stubFetch(async (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_selection_rules", {
        pageNumber: 1,
        pageSize: 20,
        subType: "Basic",
      });
      expect(JSON.parse(capturedBody).subTypeFilters).toEqual(["Basic"]);
    });

    it("passes subType='Standard' through as subTypeFilters", async () => {
      let capturedBody = "";
      stubFetch(async (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_selection_rules", {
        pageNumber: 1,
        pageSize: 20,
        subType: "Standard",
      });
      expect(JSON.parse(capturedBody).subTypeFilters).toEqual(["Standard"]);
    });

    it("rejects invalid subType values (e.g. 'basic' lowercase)", async () => {
      stubFetch(() => jsonResponse({ results: [] }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_selection_rules", {
        pageNumber: 1,
        pageSize: 20,
        subType: "basic", // should fail zod enum validation
      });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // get_selection_rule_by_name
  // -------------------------------------------------------------------------
  describe("get_selection_rule_by_name", () => {
    it("returns a single-entry matches[] with fullPath + subTypeName for one exact CI-name hit", async () => {
      stubFetch(async (url) => {
        if (url.toString().includes("search-file-infos")) {
          return jsonResponse({
            results: [
              { id: "r1", name: "Other", subTypeName: "Basic" },
              { id: "r2", name: "VIP Segment", subTypeName: "Standard" },
            ],
          });
        }
        const id = new URL(url).searchParams.get("ID");
        return jsonResponse({
          id,
          fullPath: id === "r2" ? "\\Segments\\VIP Segment" : "",
        });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_selection_rule_by_name", {
        name: "vip segment",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.matches).toHaveLength(1);
      expect(parsed.matches[0].id).toBe("r2");
      expect(parsed.matches[0].subTypeName).toBe("Standard");
      expect(parsed.matches[0].fullPath).toBe("\\Segments\\VIP Segment");
    });

    it("returns ALL matches with fullPath when multiple share the exact name (different folders)", async () => {
      const PATHS: Record<string, string> = {
        r1: "\\Marketing\\Females",
        r2: "\\Archive\\Females",
      };
      stubFetch(async (url) => {
        if (url.toString().includes("search-file-infos")) {
          return jsonResponse({
            results: [
              { id: "r1", name: "Females", subTypeName: "Standard" },
              { id: "r2", name: "Females", subTypeName: "Basic" },
              { id: "r3", name: "Females Over 30", subTypeName: "Standard" },
            ],
          });
        }
        const id = new URL(url).searchParams.get("ID");
        return jsonResponse({ id, fullPath: PATHS[id!] ?? "" });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_selection_rule_by_name", {
        name: "Females",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.matches).toHaveLength(2);
      const ids = parsed.matches.map((m: { id: string }) => m.id).sort();
      expect(ids).toEqual(["r1", "r2"]);
      // Full paths resolved per match so the LLM can disambiguate.
      const paths = parsed.matches
        .map((m: { fullPath: string }) => m.fullPath)
        .sort();
      expect(paths).toEqual(["\\Archive\\Females", "\\Marketing\\Females"]);
    });

    it("scopes the search when subType is provided", async () => {
      let capturedBody = "";
      stubFetch(async (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_selection_rule_by_name", {
        name: "VIP",
        subType: "Basic",
      });
      expect(JSON.parse(capturedBody).subTypeFilters).toEqual(["Basic"]);
    });

    it("returns found=false when no match", async () => {
      stubFetch(async () => jsonResponse({ results: [] }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_selection_rule_by_name", {
        name: "does-not-exist",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(false);
      expect(parsed.matches).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // get_basic_selection_rule_by_id
  // -------------------------------------------------------------------------
  describe("get_basic_selection_rule_by_id", () => {
    it("GETs document-database-decision with ID query", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ id: "r1", name: "Basic" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_basic_selection_rule_by_id", {
        selectionRuleId: "r1",
      });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/document-database-decision?ID=r1",
      );
    });
  });

  // -------------------------------------------------------------------------
  // get_standard_selection_rule_by_id
  // -------------------------------------------------------------------------
  describe("get_standard_selection_rule_by_id", () => {
    it("GETs standard-selection-rule with ID query (distinct from basic)", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ id: "r2", name: "Standard" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_standard_selection_rule_by_id", {
        selectionRuleId: "r2",
      });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/standard-selection-rule?ID=r2",
      );
    });
  });

  // -------------------------------------------------------------------------
  // list_basic_selection_rule_document_definitions
  // -------------------------------------------------------------------------
  describe("list_basic_selection_rule_document_definitions", () => {
    it("GETs the document-definitions endpoint with no query params", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ objects: [] });
      });
      const { server } = buildHarness();
      await invokeTool(
        server,
        "list_basic_selection_rule_document_definitions",
        { pageNumber: 1, pageSize: 20 },
      );
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/document-database-decision/document-definitions",
      );
    });

    it("filters by nameFilter (CI substring) client-side", async () => {
      stubFetch(() =>
        jsonResponse({
          objects: [
            { id: "1", name: "Customer Profile" },
            { id: "2", name: "Order History" },
            { id: "3", name: "customer preferences" },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "list_basic_selection_rule_document_definitions",
        { pageNumber: 1, pageSize: 20, nameFilter: "CUSTOMER" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalCount).toBe(2);
      expect(parsed.results.map((r: any) => r.id).sort()).toEqual(["1", "3"]);
    });

    it("paginates client-side (pageNumber=2, pageSize=5)", async () => {
      const objects = Array.from({ length: 12 }, (_, i) => ({
        id: String(i + 1),
        name: `Def${i + 1}`,
      }));
      stubFetch(() => jsonResponse({ objects }));
      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "list_basic_selection_rule_document_definitions",
        { pageNumber: 2, pageSize: 5 },
      );
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

    it("falls back gracefully when RPI uses 'results' envelope key", async () => {
      stubFetch(() =>
        jsonResponse({
          results: [{ id: "1", name: "Def1" }],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "list_basic_selection_rule_document_definitions",
        { pageNumber: 1, pageSize: 20 },
      );
      expect(JSON.parse(result.content[0].text).totalCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // X-ClientID plumbing (spot check one sub-resource)
  // -------------------------------------------------------------------------
  describe("X-ClientID header", () => {
    it("uses per-call clientId override on get_basic_selection_rule_by_id", async () => {
      let headers: Record<string, string> = {};
      stubFetch((_url, init) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({ id: "r1" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_basic_selection_rule_by_id", {
        selectionRuleId: "r1",
        clientId: "override-tenant",
      });
      expect(headers["X-ClientID"]).toBe("override-tenant");
    });

    it("uses defaultClientId on list when no override", async () => {
      let headers: Record<string, string> = {};
      stubFetch((_url, init) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_selection_rules", {
        pageNumber: 1,
        pageSize: 20,
      });
      expect(headers["X-ClientID"]).toBe("tenant-default");
    });
  });

  // -------------------------------------------------------------------------
  // Verbose filtering
  // -------------------------------------------------------------------------
  describe("verbose filtering", () => {
    it("strips $jsonType from get_standard_selection_rule_by_id by default", async () => {
      stubFetch(() =>
        jsonResponse({
          $jsonType: "StandardRule",
          id: "r1",
          name: "VIP",
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "get_standard_selection_rule_by_id",
        { selectionRuleId: "r1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.$jsonType).toBeUndefined();
      expect(parsed.name).toBe("VIP");
    });

    it("preserves $jsonType when verbose=true", async () => {
      stubFetch(() =>
        jsonResponse({
          $jsonType: "StandardRule",
          id: "r1",
          name: "VIP",
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "get_standard_selection_rule_by_id",
        { selectionRuleId: "r1", verbose: true },
      );
      expect(JSON.parse(result.content[0].text).$jsonType).toBe("StandardRule");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("returns isError=true on non-2xx response", async () => {
      stubFetch(() => new Response("boom", { status: 500 }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_basic_selection_rule_by_id", {
        selectionRuleId: "r1",
      });
      expect(result.isError).toBe(true);
    });
  });
});
