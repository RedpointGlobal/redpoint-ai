/**
 * Tests for the audience workflow tools (run_audience_test_workflow +
 * lifecycle helpers). Same mock-fetch pattern as tools-selection-rules-run.
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

describe("audience workflow lifecycle tools", () => {
  afterEach(() => restoreFetch());

  describe("run_audience_test_workflow", () => {
    it("activates → polls → fetches block results", async () => {
      const calls: Array<{ method: string; url: string; body?: string }> = [];
      const statuses = ["Playing", "Completed"];
      let pollIdx = 0;

      stubFetch(async (url, init) => {
        const u = new URL(url.toString());
        const method = init?.method ?? "GET";
        calls.push({
          method,
          url: u.toString(),
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (
          u.pathname.endsWith(
            "/client/workflows/audiences/activate-workflow-association-test",
          )
        ) {
          return jsonResponse({
            workflowAssociationID: "wa-1",
            workflowAssociationInstanceID: 101,
            interactionID: "aud-1",
          });
        }
        if (u.pathname.endsWith("/client/workflows/audiences/activity/status")) {
          return jsonResponse({
            activityID: "act-1",
            workflowAssociationID: "wa-1",
            workflowAssociationInstanceID: 101,
            dataflowInternalStatus: statuses[pollIdx++],
          });
        }
        if (
          u.pathname.endsWith(
            "/client/workflows/audiences/blocks-instance-results",
          )
        ) {
          return jsonResponse({
            objects: [{ blockInstanceID: "b-1", results: { count: 500 } }],
          });
        }
        throw new Error(`Unexpected call: ${method} ${u.toString()}`);
      });

      const { server } = buildHarness();
      const result = await invokeTool(server, "run_audience_test_workflow", {
        audienceId: "aud-1",
        isSandBox: true,
        timeoutSeconds: 5,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.workflowAssociationID).toBe("wa-1");
      expect(parsed.workflowAssociationInstanceID).toBe(101);
      expect(parsed.activityID).toBe("act-1");
      expect(parsed.blockResults.objects[0].blockInstanceID).toBe("b-1");

      const activate = calls.find((c) =>
        c.url.includes("activate-workflow-association-test"),
      )!;
      expect(activate.method).toBe("POST");
      expect(JSON.parse(activate.body!)).toEqual({
        id: "aud-1",
        isSandBox: true,
      });

      const blocks = calls.find((c) =>
        c.url.includes("blocks-instance-results"),
      )!;
      expect(blocks.url).toContain("WorkflowAssociationInstanceID=101");
      expect(blocks.url).toContain("ActivityID=act-1");
    }, 10_000);

    it("fails when RPI reports a Failed dataflow status", async () => {
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.includes("activate-workflow-association-test")) {
          return jsonResponse({
            workflowAssociationID: "wa-x",
            workflowAssociationInstanceID: 1,
          });
        }
        if (u.pathname.includes("activity/status")) {
          return jsonResponse({ dataflowInternalStatus: "Failed" });
        }
        throw new Error(`Unexpected: ${u.toString()}`);
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "run_audience_test_workflow", {
        audienceId: "aud-x",
        timeoutSeconds: 5,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Job failed");
    }, 10_000);
  });

  describe("get_audience_workflow_activity_status", () => {
    it("GETs activity/status with WorkflowAssociationInstanceID", async () => {
      let captured = "";
      stubFetch(async (url) => {
        captured = url.toString();
        return jsonResponse({ dataflowInternalStatus: "Playing" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_audience_workflow_activity_status", {
        workflowAssociationInstanceId: 77,
      });
      expect(captured).toContain(
        "/api/v2/client/workflows/audiences/activity/status",
      );
      expect(captured).toContain("WorkflowAssociationInstanceID=77");
    });
  });

  describe("get_audience_workflow_block_results", () => {
    it("GETs blocks-instance-results with both query params", async () => {
      let captured = "";
      stubFetch(async (url) => {
        captured = url.toString();
        return jsonResponse({ objects: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_audience_workflow_block_results", {
        workflowAssociationInstanceId: 42,
        activityId: "act-2",
      });
      expect(captured).toContain("ActivityID=act-2");
      expect(captured).toContain("WorkflowAssociationInstanceID=42");
    });
  });

  describe("get_audience_workflow_results", () => {
    it("POSTs to /audiences/results with query params and no body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = typeof init?.body === "string" ? init.body : undefined;
        return jsonResponse({ workflowAssociationID: "wa-9" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_audience_workflow_results", {
        workflowAssociationInstanceId: 5,
        activityId: "act-5",
        isDataflowTemplateRequired: true,
      });
      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toContain("/api/v2/client/workflows/audiences/results");
      expect(capturedUrl).toContain("WorkflowAssociationInstanceID=5");
      expect(capturedUrl).toContain("ActivityID=act-5");
      expect(capturedUrl).toContain("IsDataflowTemplateRequired=true");
      expect(capturedBody).toBeUndefined();
    });
  });

  describe("get_audience_execution_results", () => {
    it("POSTs with AudienceResultsSearchArgs.* query params", async () => {
      let capturedUrl = "";
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        expect(init?.method).toBe("POST");
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_audience_execution_results", {
        audienceId: "aud-7",
        includeAudienceTests: true,
        maxNumberOfResults: 10,
      });
      expect(capturedUrl).toContain("AudienceID=aud-7");
      expect(capturedUrl).toContain(
        encodeURIComponent("AudienceResultsSearchArgs.IncludeAudienceTests") +
          "=true",
      );
      expect(capturedUrl).toContain(
        encodeURIComponent("AudienceResultsSearchArgs.MaxNumberOfResults") +
          "=10",
      );
    });
  });

  describe("list_audience_test_instances", () => {
    it("GETs test-instances with the ID query param", async () => {
      let captured = "";
      stubFetch(async (url) => {
        captured = url.toString();
        return jsonResponse({ objects: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_audience_test_instances", {
        audienceId: "aud-test",
      });
      expect(captured).toContain(
        "/api/v2/client/workflows/audiences/test-instances?ID=aud-test",
      );
    });
  });
});
