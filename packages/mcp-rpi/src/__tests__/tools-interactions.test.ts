/**
 * Unit tests for the interactions tools. Verifies each tool hits the correct
 * RPI path with the expected PascalCase query params.
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

function buildHarness() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const auth = new RPIAuthService(
    "https://rpi.example.com",
    "oauth-id",
    "oauth-secret",
    "proxy",
    "proxy-pass",
  );
  const api = new RPIApiClient("https://rpi.example.com", auth, "tenant-default");
  registerInteractionTools(server, api);
  return { server };
}

describe("interactions tools", () => {
  afterEach(() => restoreFetch());

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------
  describe("list_interactions", () => {
    it("POSTs search-file-infos with fileTypeFilters=['Interaction']", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_interactions", {
        pageNumber: 1,
        pageSize: 20,
      });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/file-system/search-file-infos",
      );
      expect(JSON.parse(capturedBody).fileTypeFilters).toEqual(["Interaction"]);
    });

    it("returns card shape {id, name, description, parentFolderName} by default", async () => {
      stubFetch(async () =>
        jsonResponse({
          results: [
            {
              id: "i1",
              name: "Campaign A",
              description: "desc",
              parentFolderName: "Campaigns",
              subTypeName: "x",
              extra: "noise",
            },
          ],
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "list_interactions", {
        pageNumber: 1,
        pageSize: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0]).toEqual({
        id: "i1",
        name: "Campaign A",
        description: "desc",
        parentFolderName: "Campaigns",
      });
      expect(parsed.results[0].subTypeName).toBeUndefined();
      expect(parsed.results[0].extra).toBeUndefined();
    });

    it("passes nameFilter through as searchString", async () => {
      let capturedBody = "";
      stubFetch(async (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_interactions", {
        pageNumber: 1,
        pageSize: 20,
        nameFilter: "welcome",
      });
      expect(JSON.parse(capturedBody).searchString).toBe("welcome");
    });
  });

  describe("get_interaction_by_id", () => {
    it("GETs the interaction endpoint with ID query param", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ id: "i-1", name: "Welcome" });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_by_id", {
        interactionId: "i-1",
      });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/interaction?ID=i-1",
      );
    });
  });

  describe("get_interaction_by_name", () => {
    it("returns a single-entry matches[] with fullPath for one exact CI-name hit", async () => {
      stubFetch(async (url) => {
        if (url.toString().includes("search-file-infos")) {
          return jsonResponse({
            results: [
              { id: "i1", name: "Other" },
              { id: "i2", name: "Welcome" },
            ],
          });
        }
        const id = new URL(url).searchParams.get("ID");
        return jsonResponse({
          id,
          fullPath: id === "i2" ? "\\Campaigns\\Welcome" : "",
        });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_by_name", {
        name: "WELCOME",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.matches).toHaveLength(1);
      expect(parsed.matches[0].id).toBe("i2");
      expect(parsed.matches[0].fullPath).toBe("\\Campaigns\\Welcome");
    });

    it("returns ALL matches with fullPath when multiple share the exact name (different folders)", async () => {
      const PATHS: Record<string, string> = {
        i1: "\\Marketing\\Campaigns\\Welcome",
        i2: "\\Archive\\2024\\Welcome",
      };
      stubFetch(async (url) => {
        if (url.toString().includes("search-file-infos")) {
          return jsonResponse({
            results: [
              { id: "i1", name: "Welcome" },
              { id: "i2", name: "Welcome" },
              { id: "i3", name: "WelcomeBack" },
            ],
          });
        }
        const id = new URL(url).searchParams.get("ID");
        return jsonResponse({ id, fullPath: PATHS[id!] ?? "" });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_by_name", {
        name: "Welcome",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.matches).toHaveLength(2);
      const ids = parsed.matches.map((m: { id: string }) => m.id).sort();
      expect(ids).toEqual(["i1", "i2"]);
      // Full paths resolved per match so the LLM can disambiguate.
      const paths = parsed.matches
        .map((m: { fullPath: string }) => m.fullPath)
        .sort();
      expect(paths).toEqual([
        "\\Archive\\2024\\Welcome",
        "\\Marketing\\Campaigns\\Welcome",
      ]);
    });

    it("returns found=false when no match", async () => {
      stubFetch(async () => jsonResponse({ results: [] }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_by_name", {
        name: "does-not-exist",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.found).toBe(false);
      expect(parsed.matches).toBeUndefined();
    });
  });

  describe("get_interaction_workflow_instances", () => {
    const SAMPLE_ID = "7d5cfb10-3824-45f3-ba41-9dc65fc0d959";

    // The endpoint keys on versionControlID, which differs from the file id
    // callers usually hold. The tool resolves it via file-info first.
    const VERSION_CONTROL_ID = "9f185252-17ec-454a-a06b-9661ac35b253";

    it("resolves the file id to versionControlID via file-info, then GETs all-instances with it", async () => {
      let instancesUrl: URL | null = null;
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/file-system/file-info")) {
          // file-info resolves the file id -> versionControlID
          expect(u.searchParams.get("ID")).toBe(SAMPLE_ID);
          return jsonResponse({
            id: SAMPLE_ID,
            versionControlID: VERSION_CONTROL_ID,
          });
        }
        instancesUrl = u;
        return jsonResponse({
          versionControlID: VERSION_CONTROL_ID,
          isResultSetTruncated: false,
          workflowInstances: [
            {
              workflowAssociationInstanceID: 42,
              status: "TestCompleted",
              resultsCount: 303,
              dateCompleted: "2026-05-20T20:43:42Z",
            },
          ],
        });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_workflow_instances", {
        interactionId: SAMPLE_ID,
      });
      expect(result.isError).toBeFalsy();
      expect(instancesUrl!.pathname).toBe(
        "/api/v2/client/workflows/interaction/all-instances",
      );
      // Must use the RESOLVED versionControlID, not the file id we passed in.
      expect(instancesUrl!.searchParams.get("VersionControlID")).toBe(
        VERSION_CONTROL_ID,
      );
      expect(instancesUrl!.searchParams.get("GetResultCounts")).toBe("true");
      const body = JSON.parse(result.content[0].text);
      expect(body.workflowInstances).toHaveLength(1);
      expect(body.workflowInstances[0].status).toBe("TestCompleted");
    });

    it("falls back to the supplied id when file-info resolution fails", async () => {
      let instancesUrl: URL | null = null;
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/file-system/file-info")) {
          return new Response("not found", { status: 404 });
        }
        instancesUrl = u;
        return jsonResponse({ workflowInstances: [] });
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_workflow_instances", {
        interactionId: SAMPLE_ID,
      });
      expect(result.isError).toBeFalsy();
      // file-info threw → the call still goes out with the id we supplied.
      expect(instancesUrl!.searchParams.get("VersionControlID")).toBe(SAMPLE_ID);
    });

    it("sends GetResultCounts=false when getResultCounts:false is passed", async () => {
      let capturedUrl: URL | null = null;
      stubFetch(async (url) => {
        capturedUrl = new URL(url.toString());
        return jsonResponse({ workflowInstances: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_workflow_instances", {
        interactionId: SAMPLE_ID,
        getResultCounts: false,
      });
      expect(capturedUrl!.searchParams.get("GetResultCounts")).toBe("false");
    });

    it("returns isError on RPI 4xx", async () => {
      stubFetch(async () =>
        new Response("bad request", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_workflow_instances", {
        interactionId: SAMPLE_ID,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Error getting interaction workflow instances",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Sub-resources — compound key (PascalCase wire format)
  // -------------------------------------------------------------------------
  describe("get_interaction_activity", () => {
    it("sends InteractionID, WorkflowAssociationID, ActivityID in PascalCase", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ activity: {} });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_activity", {
        interactionId: "i-1",
        workflowAssociationId: "w-1",
        activityId: "a-1",
      });
      expect(capturedUrl).toContain("/client/files/interaction/activity");
      expect(capturedUrl).toContain("InteractionID=i-1");
      expect(capturedUrl).toContain("WorkflowAssociationID=w-1");
      expect(capturedUrl).toContain("ActivityID=a-1");
    });
  });

  describe("get_interaction_trigger", () => {
    it("sends InteractionID and WorkflowAssociationID", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ trigger: {} });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_trigger", {
        interactionId: "i-1",
        workflowAssociationId: "w-1",
      });
      expect(capturedUrl).toContain("/client/files/interaction/trigger");
      expect(capturedUrl).toContain("InteractionID=i-1");
      expect(capturedUrl).toContain("WorkflowAssociationID=w-1");
    });
  });

  describe("get_interaction_available_inputs", () => {
    it("sends all three compound-key params", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ inputs: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_available_inputs", {
        interactionId: "i-1",
        workflowAssociationId: "w-1",
        activityId: "a-1",
      });
      expect(capturedUrl).toContain(
        "/client/files/interaction/available-inputs",
      );
      expect(capturedUrl).toContain("InteractionID=i-1");
      expect(capturedUrl).toContain("WorkflowAssociationID=w-1");
      expect(capturedUrl).toContain("ActivityID=a-1");
    });
  });

  describe("get_interaction_default_metadata", () => {
    it("sends all three compound-key params", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ metadata: {} });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_default_metadata", {
        interactionId: "i-1",
        workflowAssociationId: "w-1",
        activityId: "a-1",
      });
      expect(capturedUrl).toContain(
        "/client/files/interaction/default-metadata",
      );
      expect(capturedUrl).toContain("InteractionID=i-1");
      expect(capturedUrl).toContain("WorkflowAssociationID=w-1");
      expect(capturedUrl).toContain("ActivityID=a-1");
    });
  });

  describe("get_interaction_workflows", () => {
    it("sends ID (capitalized) as the single param", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ workflows: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_workflows", {
        interactionId: "i-1",
      });
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/interaction/workflows?ID=i-1",
      );
    });
  });

  describe("get_interaction_workflow_activities", () => {
    it("hits the singular /workflow/activities path", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ activities: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_workflow_activities", {
        interactionId: "i-1",
        workflowAssociationId: "w-1",
      });
      expect(capturedUrl).toContain(
        "/client/files/interaction/workflow/activities",
      );
      expect(capturedUrl).toContain("InteractionID=i-1");
      expect(capturedUrl).toContain("WorkflowAssociationID=w-1");
    });
  });

  describe("calculate_interaction_next_firing_times", () => {
    it("sends WorkflowAssociationID without numberOfSchedules when omitted", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ times: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "calculate_interaction_next_firing_times", {
        workflowAssociationId: "w-1",
      });
      expect(capturedUrl).toContain(
        "/client/files/interaction/calculate/trigger-recurrence/next-firing-times",
      );
      expect(capturedUrl).toContain("WorkflowAssociationID=w-1");
      expect(capturedUrl).not.toContain("NumberOfSchedules");
    });

    it("includes NumberOfSchedules when provided", async () => {
      let capturedUrl = "";
      stubFetch((url) => {
        capturedUrl = url.toString();
        return jsonResponse({ times: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "calculate_interaction_next_firing_times", {
        workflowAssociationId: "w-1",
        numberOfSchedules: 5,
      });
      expect(capturedUrl).toContain("NumberOfSchedules=5");
    });
  });

  // -------------------------------------------------------------------------
  // X-ClientID header resolution — spot-check list + a compound-key sub-resource
  // to confirm the plumbing works through every tool path.
  // -------------------------------------------------------------------------
  describe("X-ClientID header", () => {
    it("uses defaultClientId on list_interactions when no override is passed", async () => {
      let headers: Record<string, string> = {};
      stubFetch((_url, init) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_interactions", {
        pageNumber: 1,
        pageSize: 20,
      });
      expect(headers["X-ClientID"]).toBe("tenant-default");
    });

    it("uses per-call clientId override on list_interactions", async () => {
      let headers: Record<string, string> = {};
      stubFetch((_url, init) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({ results: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "list_interactions", {
        pageNumber: 1,
        pageSize: 20,
        clientId: "override",
      });
      expect(headers["X-ClientID"]).toBe("override");
    });

    it("uses per-call clientId override on get_interaction_activity (compound-key tool)", async () => {
      let headers: Record<string, string> = {};
      stubFetch((_url, init) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({ activity: {} });
      });
      const { server } = buildHarness();
      await invokeTool(server, "get_interaction_activity", {
        interactionId: "i-1",
        workflowAssociationId: "w-1",
        activityId: "a-1",
        clientId: "tenant-xyz",
      });
      expect(headers["X-ClientID"]).toBe("tenant-xyz");
    });

    it("uses per-call clientId override on calculate_interaction_next_firing_times", async () => {
      let headers: Record<string, string> = {};
      stubFetch((_url, init) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({ times: [] });
      });
      const { server } = buildHarness();
      await invokeTool(server, "calculate_interaction_next_firing_times", {
        workflowAssociationId: "w-1",
        clientId: "tenant-xyz",
      });
      expect(headers["X-ClientID"]).toBe("tenant-xyz");
    });
  });

  // -------------------------------------------------------------------------
  // Verbose response filtering — confirm it's wired through on at least one
  // sub-resource tool path (the shared RPIApiClient already has dedicated
  // tests but we want parity with audiences/admin coverage).
  // -------------------------------------------------------------------------
  describe("verbose filtering", () => {
    it("strips verbose fields from get_interaction_by_id by default", async () => {
      stubFetch(() =>
        jsonResponse({
          $jsonType: "Interaction",
          $jsonTypeID: "guid",
          id: "i-1",
          name: "Welcome",
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_by_id", {
        interactionId: "i-1",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.$jsonType).toBeUndefined();
      expect(parsed.$jsonTypeID).toBeUndefined();
      expect(parsed.name).toBe("Welcome");
    });

    it("preserves verbose fields when verbose=true", async () => {
      stubFetch(() =>
        jsonResponse({
          $jsonType: "Interaction",
          id: "i-1",
          name: "Welcome",
        }),
      );
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_by_id", {
        interactionId: "i-1",
        verbose: true,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.$jsonType).toBe("Interaction");
      expect(parsed.name).toBe("Welcome");
    });
  });

  describe("error handling", () => {
    it("returns isError=true on non-2xx response", async () => {
      stubFetch(() => new Response("boom", { status: 500 }));
      const { server } = buildHarness();
      const result = await invokeTool(server, "get_interaction_by_id", {
        interactionId: "i-1",
      });
      expect(result.isError).toBe(true);
    });
  });
});
