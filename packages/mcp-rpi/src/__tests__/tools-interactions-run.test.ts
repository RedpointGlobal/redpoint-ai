/**
 * Tests for the interaction workflow tools (activate, run, instance summary,
 * bulk status, and control). Same mock-fetch pattern as the other lifecycle
 * test files.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerInteractionTools } from "../tools/interactions.js";

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
  registerInteractionTools(server, api);
  return { server };
}

describe("interaction workflow lifecycle tools", () => {
  afterEach(() => restoreFetch());

  describe("activate_interaction_workflow", () => {
    it("POSTs to activate-workflow-association with id, workflowAssociationID, isSandBox", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedBody = init?.body as string;
        return jsonResponse({
          workflowAssociationID: "wa-a",
          workflowAssociationInstanceID: 5,
          currentStatus: "Started",
        });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "activate_interaction_workflow", {
        interactionId: "int-1",
        workflowAssociationId: "wa-a",
        isSandBox: true,
      });
      expect(capturedUrl).toContain(
        "/api/v2/client/workflows/interactions/activate-workflow-association",
      );
      const body = JSON.parse(capturedBody);
      expect(body).toEqual({
        id: "int-1",
        workflowAssociationID: "wa-a",
        isSandBox: true,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.workflowAssociationInstanceID).toBe(5);
    });
  });

  describe("run_interaction_workflow", () => {
    it("activates then polls instance summary until Completed", async () => {
      const statuses = ["Playing", "Completed"];
      let pollIdx = 0;
      const calls: Array<{ method: string; url: string }> = [];
      stubFetch(async (url, init) => {
        const u = new URL(url.toString());
        calls.push({ method: init?.method ?? "GET", url: u.toString() });
        if (u.pathname.endsWith("/activate-workflow-association")) {
          return jsonResponse({
            workflowAssociationID: "wa-b",
            workflowAssociationInstanceID: 22,
          });
        }
        if (u.pathname.endsWith("/workflows/instances/summary")) {
          return jsonResponse({
            workflowAssociationInstanceID: 22,
            currentStatus: statuses[pollIdx++],
          });
        }
        throw new Error(`Unexpected: ${u.toString()}`);
      }, );
      const { server } = buildHarness();
      const result = await invokeTool(server, "run_interaction_workflow", {
        interactionId: "int-2",
        workflowAssociationId: "wa-b",
        timeoutSeconds: 5,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.workflowAssociationInstanceID).toBe(22);
      expect(parsed.status.currentStatus).toBe("Completed");

      const summaryCalls = calls.filter((c) =>
        c.url.includes("/workflows/instances/summary"),
      );
      expect(summaryCalls.length).toBe(2);
      expect(summaryCalls[0].url).toContain("WorkflowAssociationInstanceID=22");
    }, 10_000);

    it("reports a failure when the instance reaches a terminal failure status", async () => {
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/activate-workflow-association")) {
          return jsonResponse({
            workflowAssociationID: "wa-c",
            workflowAssociationInstanceID: 33,
          });
        }
        if (u.pathname.endsWith("/workflows/instances/summary")) {
          return jsonResponse({ currentStatus: "Failed" });
        }
        throw new Error(`Unexpected: ${u.toString()}`);
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "run_interaction_workflow", {
        interactionId: "int-fail",
        workflowAssociationId: "wa-c",
        timeoutSeconds: 5,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Job failed");
    }, 10_000);
  });

  describe("get_workflow_instance_summary", () => {
    it("GETs instances/summary with WorkflowAssociationInstanceID", async () => {
      let captured = "";
      stubFetch(async (url) => {
        captured = url.toString();
        return jsonResponse({ currentStatus: "Playing" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_workflow_instance_summary", {
        workflowAssociationInstanceId: 91,
      });
      expect(captured).toContain(
        "/api/v2/client/workflows/instances/summary?WorkflowAssociationInstanceID=91",
      );
    });
  });

  describe("get_interactions_workflow_status", () => {
    it("POSTs interactions/status with { ids: [...] }", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedBody = init?.body as string;
        return jsonResponse({ objects: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interactions_workflow_status", {
        interactionIds: ["int-A", "int-B"],
      });
      expect(capturedUrl).toContain(
        "/api/v2/client/workflows/interactions/status",
      );
      expect(JSON.parse(capturedBody)).toEqual({
        ids: ["int-A", "int-B"],
      });
    });
  });

  describe("control_workflow_instance", () => {
    it("PATCHes activity-action with the given action and instance ID", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      let capturedBody = "";
      stubFetch(async (url, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = url.toString();
        capturedBody = init?.body as string;
        return jsonResponse({ workflowAssociationInstanceID: 55 });
      });
      const { server } = buildHarness();
      await invokeTool(server, "control_workflow_instance", {
        workflowAssociationInstanceId: 55,
        workflowAction: "Stop",
      });
      expect(capturedMethod).toBe("PATCH");
      expect(capturedUrl).toContain("/api/v2/client/workflows/activity-action");
      expect(JSON.parse(capturedBody)).toEqual({
        workflowAssociationInstanceID: 55,
        workflowAction: "Stop",
      });
    });
  });
});
