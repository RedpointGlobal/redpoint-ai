/**
 * Unit tests for admin-domain tools. Verify:
 *  - new operation-management tools hit the expected RPI paths with expected
 *    query params
 *  - default responses are passed through the verbose-field filter
 *  - verbose=true bypasses the filter
 *
 * Uses a real McpServer with a stubbed RPIApiClient (mocked fetch).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerAdminTools } from "../tools/admin.js";

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
    "client",
    "secret",
    "proxy-user",
    "proxy-pass",
  );
  const api = new RPIApiClient("https://rpi.example.com", auth, "test-client");
  registerAdminTools(server, api);
  return { server };
}

describe("admin tools", () => {
  afterEach(() => restoreFetch());

  describe("verbose filtering", () => {
    it("strips $jsonType from the response by default", async () => {
      stubFetch(() =>
        jsonResponse({
          $jsonType: "SystemHealth",
          $jsonTypeID: "sh-1",
          overall: "Healthy",
        }),
      );

      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "get_system_health_availability",
        {},
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.$jsonType).toBeUndefined();
      expect(parsed.$jsonTypeID).toBeUndefined();
      expect(parsed.overall).toBe("Healthy");
    });

    it("preserves $jsonType when verbose=true", async () => {
      stubFetch(() =>
        jsonResponse({ $jsonType: "SystemHealth", overall: "Healthy" }),
      );

      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "get_system_health_availability",
        { verbose: true },
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.$jsonType).toBe("SystemHealth");
      expect(parsed.overall).toBe("Healthy");
    });
  });

  describe("get_system_health_availability", () => {
    it("calls the cluster availability endpoint", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ availability: "Available" });
      });

      const { server } = buildHarness();
      await invokeTool(server, "get_system_health_availability", {});

      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/cluster/operations/system-health/availability",
      );
    });
  });

  describe("get_cluster_api_error_log", () => {
    it("passes pageNumber and pageSize as query params", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ errors: [] });
      });

      const { server } = buildHarness();
      await invokeTool(server, "get_cluster_api_error_log", {
        pageNumber: 3,
        pageSize: 50,
      });

      expect(capturedUrl).toContain(
        "/cluster/operations/logs/error/api",
      );
      expect(capturedUrl).toContain("pageNumber=3");
      expect(capturedUrl).toContain("pageSize=50");
    });

    it("includes titleContains and clientID when provided", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ errors: [] });
      });

      const { server } = buildHarness();
      await invokeTool(server, "get_cluster_api_error_log", {
        pageNumber: 1,
        pageSize: 20,
        titleContains: "timeout",
        filterClientId: "abc-123",
      });

      expect(capturedUrl).toContain("titleContains=timeout");
      expect(capturedUrl).toContain("clientID=abc-123");
    });

    it("omits optional filters when not provided", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ errors: [] });
      });

      const { server } = buildHarness();
      await invokeTool(server, "get_cluster_api_error_log", {
        pageNumber: 1,
        pageSize: 20,
      });

      expect(capturedUrl).not.toContain("titleContains");
      expect(capturedUrl).not.toContain("clientID");
    });
  });

  describe("get_cluster_audit_history", () => {
    it("calls the audit-history endpoint with pagination", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ entries: [] });
      });

      const { server } = buildHarness();
      await invokeTool(server, "get_cluster_audit_history", {
        pageNumber: 2,
        pageSize: 10,
      });

      expect(capturedUrl).toContain("/cluster/operations/logs/audit-history");
      expect(capturedUrl).toContain("pageNumber=2");
      expect(capturedUrl).toContain("pageSize=10");
    });
  });

  describe("error handling", () => {
    it("returns isError=true on non-2xx response", async () => {
      stubFetch(() => new Response("boom", { status: 500 }));

      const { server } = buildHarness();
      const result = await invokeTool(
        server,
        "get_system_health_availability",
        {},
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });
});
