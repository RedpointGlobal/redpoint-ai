/**
 * Tests for the selection-rule lifecycle tools (run_selection_rule_count,
 * run_selection_rule_waterfall, get_selection_rule_sql_count_query).
 *
 * `fetch` is mocked to script a three-phase lifecycle: start → status → results.
 * The start and status calls share a URL pattern; we route by path + method.
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
  registerSelectionRuleTools(server, api);
  return { server };
}

describe("selection-rule lifecycle tools", () => {
  afterEach(() => restoreFetch());

  describe("run_selection_rule_count", () => {
    it("starts the job, polls status until Completed, and returns results", async () => {
      const calls: Array<{ method: string; url: string; body?: string }> = [];
      const statuses = ["Executing", "Completed"];
      let pollIdx = 0;

      stubFetch(async (url, init) => {
        const u = new URL(url.toString());
        const method = init?.method ?? "GET";
        calls.push({
          method,
          url: u.toString(),
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (u.pathname.endsWith("/client/jobs/start/selection-rule-count")) {
          return jsonResponse({ jobID: 42, status: "WaitingExecution" });
        }
        if (u.pathname.endsWith("/client/jobs/job/status")) {
          return jsonResponse({ jobID: 42, status: statuses[pollIdx++] });
        }
        // Selection-rule COUNT jobs persist to the DEDICATED
        // selection-rule-count-results endpoint. The generic
        // /client/jobs/results/count-results is a DIFFERENT endpoint and
        // 404s for these jobs (the bug fixed here, parallel to waterfall).
        // NOTE: match the FULL path. Never weaken this to a bare
        // `endsWith("count-results")` — `selection-rule-count-results`
        // also ends with `count-results`, so a bare suffix collapses the
        // two endpoints' distinguishability and silently reintroduces the
        // blindspot that let this ship twice.
        if (
          u.pathname.endsWith(
            "/client/jobs/results/selection-rule-count-results",
          )
        ) {
          // RPI keys results by (ID, PageNumber). Omitting PageNumber 404s
          // with API-ClientJobResultsNotFound — replicate that so a future
          // regression (dropping PageNumber) fails loudly instead of green.
          if (!u.searchParams.get("PageNumber")) {
            return jsonResponse(
              {
                error:
                  "API-ClientJobResultsNotFound — The job results with ID '42' and page number '' not found.",
              },
              404,
            );
          }
          return jsonResponse({
            results: [{ name: "Total", count: 1234 }],
          });
        }
        // Hard guard: hitting the GENERIC count-results endpoint is the
        // regression. Fail loudly with a distinct message instead of a
        // generic "unexpected call".
        if (u.pathname.endsWith("/client/jobs/results/count-results")) {
          throw new Error(
            `REGRESSION: count tool hit the GENERIC /client/jobs/results/count-results — must use the dedicated selection-rule-count-results endpoint`,
          );
        }
        throw new Error(`Unexpected call: ${method} ${u.toString()}`);
      });

      const { server } = buildHarness();
      const result = await invokeTool(server, "run_selection_rule_count", {
        selectionRuleId: "rule-1",
        // short interval to avoid waiting 1s in the test runtime
        timeoutSeconds: 5,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.jobId).toBe(42);
      expect(parsed.status.status).toBe("Completed");
      expect(parsed.results.results[0].count).toBe(1234);

      // Verify the lifecycle: 1 start POST, 2 status GETs, 1 results GET.
      const startCall = calls.find((c) =>
        c.url.endsWith("/client/jobs/start/selection-rule-count"),
      )!;
      expect(startCall.method).toBe("POST");
      expect(JSON.parse(startCall.body!)).toEqual({ id: "rule-1" });

      const statusCalls = calls.filter((c) =>
        c.url.includes("/client/jobs/job/status"),
      );
      expect(statusCalls.length).toBe(2);
      expect(statusCalls[0].url).toContain("ID=42");

      const resultsCall = calls.find((c) =>
        c.url.includes("/client/jobs/results/selection-rule-count-results"),
      )!;
      expect(resultsCall.method).toBe("GET");
      expect(resultsCall.url).toContain("ID=42");
      // Regression lock: results are keyed by (ID, PageNumber); omitting
      // PageNumber 404s against real RPI. Must always be sent.
      expect(resultsCall.url).toContain("PageNumber=1");
      // The count tool must NEVER touch the generic count-results endpoint
      // (different endpoint; 404s for selection-rule count jobs).
      expect(
        calls.some(
          (c) =>
            c.url.includes("/client/jobs/results/count-results") &&
            !c.url.includes(
              "/client/jobs/results/selection-rule-count-results",
            ),
        ),
      ).toBe(false);
    }, 10_000);

    it("surfaces the RPI 404 if the results fetch omits PageNumber", async () => {
      // Mock 404s exactly like real RPI when PageNumber is absent. With the
      // fix in place the tool sends PageNumber=1, so this stays green; if a
      // regression drops the param, the tool surfaces API-ClientJobResultsNotFound.
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/client/jobs/start/selection-rule-count")) {
          return jsonResponse({ jobID: 42, status: "WaitingExecution" });
        }
        if (u.pathname.endsWith("/client/jobs/job/status")) {
          return jsonResponse({ jobID: 42, status: "Completed" });
        }
        // Dedicated endpoint (see note in the first test): match the FULL
        // path, never a bare `count-results` suffix.
        if (
          u.pathname.endsWith(
            "/client/jobs/results/selection-rule-count-results",
          )
        ) {
          if (!u.searchParams.get("PageNumber")) {
            return jsonResponse(
              {
                error:
                  "API-ClientJobResultsNotFound — The job results with ID '42' and page number '' not found.",
              },
              404,
            );
          }
          return jsonResponse({ results: [{ name: "Total", count: 1 }] });
        }
        if (u.pathname.endsWith("/client/jobs/results/count-results")) {
          throw new Error(
            `REGRESSION: count tool hit the GENERIC count-results endpoint`,
          );
        }
        throw new Error(`Unexpected call: ${u.toString()}`);
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "run_selection_rule_count", {
        selectionRuleId: "rule-1",
        timeoutSeconds: 5,
      });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).results.results[0].count).toBe(
        1,
      );
    }, 10_000);

    it("throws a JobFailed error when the job status becomes Failed", async () => {
      stubFetch(async (url) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/client/jobs/start/selection-rule-count")) {
          return jsonResponse({ jobID: 99, status: "WaitingExecution" });
        }
        if (u.pathname.endsWith("/client/jobs/job/status")) {
          return jsonResponse({
            jobID: 99,
            status: "Failed",
            errorMessage: "rule missing resolution level",
          });
        }
        throw new Error(`Unexpected call: ${u.toString()}`);
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "run_selection_rule_count", {
        selectionRuleId: "rule-bad",
        timeoutSeconds: 5,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("rule missing resolution level");
    }, 10_000);
  });

  describe("run_selection_rule_waterfall", () => {
    it("starts the waterfall job and fetches the dedicated waterfall-results endpoint (not count-results)", async () => {
      const calls: Array<{ method: string; url: string }> = [];
      stubFetch(async (url, init) => {
        const u = new URL(url.toString());
        const method = init?.method ?? "GET";
        calls.push({ method, url: u.toString() });
        if (
          method === "POST" &&
          u.pathname.endsWith("/client/jobs/start/selection-rule-waterfall")
        ) {
          return jsonResponse({ jobID: 7, status: "WaitingExecution" });
        }
        if (u.pathname.endsWith("/client/jobs/job/status")) {
          return jsonResponse({ jobID: 7, status: "Completed" });
        }
        if (
          u.pathname.endsWith(
            "/client/jobs/results/selection-rule-waterfall-results",
          )
        ) {
          // Waterfall results have a distinct shape from count-results:
          // totalCount + per-criterion breakdown. isPagingSupported=false,
          // so page 1 is always the complete result.
          if (!u.searchParams.get("PageNumber")) {
            return jsonResponse(
              {
                error:
                  "API-ClientJobResultsNotFound — The job results with ID '7' and page number '' not found.",
              },
              404,
            );
          }
          return jsonResponse({
            totalCount: 500,
            criterionCounts: [
              { criterionName: "Age > 18", count: 800 },
              { criterionName: "Opted in", count: 500 },
            ],
            isPagingSupported: false,
          });
        }
        throw new Error(`Unexpected call: ${method} ${u.toString()}`);
      });
      const { server } = buildHarness();
      const result = await invokeTool(server, "run_selection_rule_waterfall", {
        selectionRuleId: "rule-2",
        timeoutSeconds: 5,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.jobId).toBe(7);
      expect(parsed.results.totalCount).toBe(500);
      expect(parsed.results.criterionCounts).toHaveLength(2);

      const startCall = calls.find((c) =>
        c.url.endsWith("/client/jobs/start/selection-rule-waterfall"),
      )!;
      expect(startCall.method).toBe("POST");

      const resultsCall = calls.find((c) =>
        c.url.includes(
          "/client/jobs/results/selection-rule-waterfall-results",
        ),
      )!;
      expect(resultsCall.method).toBe("GET");
      expect(resultsCall.url).toContain("ID=7");
      expect(resultsCall.url).toContain("PageNumber=1");

      // Waterfall must NOT use the count-results endpoint — that returns a
      // count payload with no per-criterion breakdown (the prior bug).
      expect(
        calls.some((c) => c.url.includes("/client/jobs/results/count-results")),
      ).toBe(false);
    }, 10_000);
  });

  describe("get_selection_rule_sql_count_query", () => {
    it("GETs sqlCountQuery with the ID query param and passes X-ClientID", async () => {
      let capturedUrl = "";
      let capturedClientHeader = "";
      stubFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedClientHeader =
          (init?.headers as Record<string, string>)?.["X-ClientID"] ?? "";
        return jsonResponse({ sqlQuery: "SELECT COUNT(*) FROM X" });
      });
      const { server } = buildHarness("default-tenant");
      const result = await invokeTool(
        server,
        "get_selection_rule_sql_count_query",
        { selectionRuleId: "rule-9", clientId: "override-tenant" },
      );
      expect(capturedUrl).toBe(
        "https://rpi.example.com/api/v2/client/files/standard-selection-rule/sqlCountQuery?ID=rule-9",
      );
      expect(capturedClientHeader).toBe("override-tenant");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sqlQuery).toBe("SELECT COUNT(*) FROM X");
    });
  });
});
