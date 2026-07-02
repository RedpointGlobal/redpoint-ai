/**
 * Unit tests for the clients tools. Verifies each tool hits the cluster
 * endpoint, applies the correct client-side filter, and returns the expected
 * response shape.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerClientTools } from "../tools/clients.js";

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
  registerClientTools(server, api);
  return { server };
}

const threeClients = {
  clients: [
    { id: "c1", name: "Acme Prod", description: "prod" },
    { id: "c2", name: "Acme Dev", description: "dev" },
    { id: "c3", name: "Beta Test", description: "beta" },
  ],
};

describe("clients tools", () => {
  afterEach(() => restoreFetch());

  describe("list_clients", () => {
    it("GETs /cluster/operations/clients", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse(threeClients);
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_clients", { pageNumber: 1, pageSize: 20 });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/cluster/operations/clients",
      );
    });

    it("returns card shape {id, name, description} by default (strips databaseSuffix, status, etc.)", async () => {
      stubFetch(() =>
        jsonResponse({
          clients: [
            {
              id: "c1",
              name: "Acme",
              description: "prod tenant",
              databaseSuffix: "_acme",
              status: "Installed",
              dataWarehouseSchema: "dbo",
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_clients", {
        pageNumber: 1,
        pageSize: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0]).toEqual({
        id: "c1",
        name: "Acme",
        description: "prod tenant",
      });
      expect(parsed.results[0].databaseSuffix).toBeUndefined();
      expect(parsed.results[0].status).toBeUndefined();
    });

    it("returns full shape when verbose=true", async () => {
      stubFetch(() => jsonResponse(threeClients));
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_clients", {
        pageNumber: 1,
        pageSize: 20,
        verbose: true,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0].description).toBe("prod");
    });

    it("returns all clients when no nameFilter", async () => {
      stubFetch(() => jsonResponse(threeClients));
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_clients", {
        pageNumber: 1,
        pageSize: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalCount).toBe(3);
      expect(parsed.results.length).toBe(3);
    });

    it("filters by nameFilter (CI substring) client-side", async () => {
      stubFetch(() => jsonResponse(threeClients));
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_clients", {
        pageNumber: 1,
        pageSize: 20,
        nameFilter: "ACME",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalCount).toBe(2);
      expect(parsed.results.map((r: any) => r.id).sort()).toEqual(["c1", "c2"]);
    });

    it("paginates client-side", async () => {
      const big = {
        clients: Array.from({ length: 12 }, (_, i) => ({
          id: `c${i + 1}`,
          name: `Client${i + 1}`,
        })),
      };
      stubFetch(() => jsonResponse(big));
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_clients", {
        pageNumber: 2,
        pageSize: 5,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalCount).toBe(12);
      expect(parsed.results.map((r: any) => r.id)).toEqual([
        "c6",
        "c7",
        "c8",
        "c9",
        "c10",
      ]);
    });
  });

  describe("get_client_by_id", () => {
    it("finds by CI id equals", async () => {
      stubFetch(() => jsonResponse(threeClients));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_client_by_id", { id: "C2" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.match.name).toBe("Acme Dev");
    });

    it("returns found=false when no match", async () => {
      stubFetch(() => jsonResponse(threeClients));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_client_by_id", {
        id: "missing",
      });
      expect(JSON.parse(result.content[0].text).found).toBe(false);
    });
  });

  describe("get_client_by_name", () => {
    it("finds by CI name equals", async () => {
      stubFetch(() => jsonResponse(threeClients));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_client_by_name", {
        name: "acme prod",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.match.id).toBe("c1");
    });

    it("does not match by substring (must be exact)", async () => {
      stubFetch(() => jsonResponse(threeClients));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_client_by_name", {
        name: "acme",
      });
      expect(JSON.parse(result.content[0].text).found).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns isError=true on non-2xx response", async () => {
      stubFetch(() => new Response("boom", { status: 500 }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_clients", {
        pageNumber: 1,
        pageSize: 20,
      });
      expect(result.isError).toBe(true);
    });
  });
});
