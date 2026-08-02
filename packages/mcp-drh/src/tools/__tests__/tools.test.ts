import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DRHAuthService } from "../../client/drh-auth.js";
import { DRHApiClient } from "../../client/drh-api.js";
import { registerDatabaseTools } from "../databases.js";
import { registerSourceTools } from "../sources.js";
import { registerFeedTools } from "../feeds.js";
import { registerRunTools } from "../runs.js";
import { registerDataQualityTools } from "../data-qualities.js";
import { registerSubjectAreaTools } from "../subject-areas.js";
import { registerScheduleTools } from "../schedules.js";
import { registerAggsTools } from "../aggs.js";
import { registerAutomationLogTools } from "../automation-logs.js";
import { registerUiDashboardTools } from "../ui-dashboard.js";
import { registerAuthTools } from "../auth.js";

/**
 * Tool unit tests: register the real tool files onto a fake MCP server that
 * captures handlers, back the DRHApiClient with a URL-aware mock fetch, invoke
 * handlers, and assert method / path / X-ClientId / Authorization / body — the
 * contract that matters, without a live DRH.
 */
const BASE = "https://drh.example.test";
const realFetch = globalThis.fetch;

interface Captured {
  name: string;
  handler: (args: any, extra: any) => Promise<unknown>;
}
let apiCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;

function fakeServer() {
  const tools = new Map<string, Captured>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Captured["handler"]) {
      tools.set(name, { name, handler });
    },
  };
  return { server: server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, tools };
}

function installFetch() {
  apiCalls = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/auth/signon"))
      return new Response(JSON.stringify({ token: "proxy-1" }), { status: 200 });
    apiCalls.push({
      url: String(url),
      method: (init?.method || "GET").toUpperCase(),
      headers: (init?.headers || {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

function build() {
  const auth = new DRHAuthService(BASE, "svc", "pw");
  const client = new DRHApiClient(BASE, auth, "tenant-default", 1); // defaultDatabaseId=1
  const db = fakeServer();
  registerDatabaseTools(db.server, client);
  const src = fakeServer();
  registerSourceTools(src.server, client);
  const fd = fakeServer();
  registerFeedTools(fd.server, client);
  const rn = fakeServer();
  registerRunTools(rn.server, client);
  const dq = fakeServer();
  registerDataQualityTools(dq.server, client);
  const sa = fakeServer();
  registerSubjectAreaTools(sa.server, client);
  const sc = fakeServer();
  registerScheduleTools(sc.server, client);
  const ag = fakeServer();
  registerAggsTools(ag.server, client);
  const al = fakeServer();
  registerAutomationLogTools(al.server, client);
  const ui = fakeServer();
  registerUiDashboardTools(ui.server, client);
  const au = fakeServer();
  registerAuthTools(au.server, client);
  const tools = new Map([
    ...db.tools,
    ...src.tools,
    ...fd.tools,
    ...rn.tools,
    ...dq.tools,
    ...sa.tools,
    ...sc.tools,
    ...ag.tools,
    ...al.tools,
    ...ui.tools,
    ...au.tools,
  ]);
  return tools;
}

beforeEach(installFetch);
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("DRH tools (databases + sources + auth)", () => {
  it("registers the expected tool counts (databases 10, sources 10, feeds 15, runs 12, data-qualities 7, subject-areas 6, schedules 9, aggs 5, automation-logs 5, ui 13, auth 1)", () => {
    const db = fakeServer();
    registerDatabaseTools(db.server, {} as DRHApiClient);
    const src = fakeServer();
    registerSourceTools(src.server, {} as DRHApiClient);
    const fd = fakeServer();
    registerFeedTools(fd.server, {} as DRHApiClient);
    const rn = fakeServer();
    registerRunTools(rn.server, {} as DRHApiClient);
    const dq = fakeServer();
    registerDataQualityTools(dq.server, {} as DRHApiClient);
    const sa = fakeServer();
    registerSubjectAreaTools(sa.server, {} as DRHApiClient);
    const sc = fakeServer();
    registerScheduleTools(sc.server, {} as DRHApiClient);
    const ag = fakeServer();
    registerAggsTools(ag.server, {} as DRHApiClient);
    const al = fakeServer();
    registerAutomationLogTools(al.server, {} as DRHApiClient);
    const ui = fakeServer();
    registerUiDashboardTools(ui.server, {} as DRHApiClient);
    const au = fakeServer();
    registerAuthTools(au.server, {} as DRHApiClient);
    expect(db.tools.size).toBe(10);
    expect(src.tools.size).toBe(10);
    expect(fd.tools.size).toBe(15);
    expect(rn.tools.size).toBe(12);
    expect(dq.tools.size).toBe(7);
    expect(sa.tools.size).toBe(6);
    expect(sc.tools.size).toBe(9);
    expect(ag.tools.size).toBe(5);
    expect(al.tools.size).toBe(5);
    expect(ui.tools.size).toBe(13);
    expect(au.tools.size).toBe(1);
  });

  it("ui-dashboard: all reads are database-scoped GETs; nested feed-version path", async () => {
    const tools = build();
    await tools.get("drh_get_database_summary")!.handler({ databaseId: 4 }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("GET");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/4/summary`);
    apiCalls = [];
    await tools.get("drh_get_database_cdp_summary")!.handler({ databaseId: 4 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/4/cdp/summary`);
    apiCalls = [];
    await tools
      .get("drh_get_database_feed_version")!
      .handler({ databaseId: 4, feedId: 7, versionNumber: 2 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/4/feeds/7/2`);
  });

  it("ui-dashboard: feeds-page forwards paging/filter/sort query params", async () => {
    const tools = build();
    await tools
      .get("drh_list_database_feeds_page")!
      .handler(
        { databaseId: 4, pageNumber: 2, pageSize: 25, feedStatus: "active", sortField: "name", sortDirection: "asc" },
        { authInfo: undefined },
      );
    expect(apiCalls[0].url).toBe(
      `${BASE}/api-op/v1/databases/4/feeds-page?pageNumber=2&pageSize=25&feedStatus=active&sortField=name&sortDirection=asc`,
    );
  });

  it("ui-dashboard: feeds/summary uses the kebab-case source-id query key", async () => {
    const tools = build();
    await tools.get("drh_get_database_feeds_summary")!.handler({ databaseId: 4, sourceId: 9 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/4/feeds/summary?source-id=9`);
  });

  it("ui-dashboard: activities joins excludeObjectType array into the query", async () => {
    const tools = build();
    await tools
      .get("drh_list_database_activities")!
      .handler({ databaseId: 4, excludeObjectType: ["Feed", "Source"] }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/4/activities?excludeObjectType=Feed%2CSource`);
  });

  it("schedules: control_schedule maps the action enum to the sub-path (string id encoded)", async () => {
    const tools = build();
    for (const action of ["pause", "resume", "force-run"] as const) {
      apiCalls = [];
      await tools.get("drh_control_schedule")!.handler({ scheduleId: "sch a", action }, { authInfo: undefined });
      expect(apiCalls[0].method).toBe("POST");
      expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/schedules-v3/sch%20a/${action}`);
    }
  });

  it("schedules: restart passes optional stepId as a query param", async () => {
    const tools = build();
    await tools.get("drh_restart_schedule")!.handler({ scheduleId: "s1", stepId: 4 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/schedules-v3/s1/restart?stepId=4`);
  });

  it("schedules: list forwards optional filters as query params", async () => {
    const tools = build();
    await tools.get("drh_list_schedules")!.handler({ databaseId: 2, deleted: true }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/schedules-v3?databaseId=2&deleted=true`);
  });

  it("schedules: get_schedule_by_job hits the jobs sub-path", async () => {
    const tools = build();
    await tools.get("drh_get_schedule_by_job")!.handler({ jobId: "job-9" }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/schedules-v3/jobs/job-9`);
  });

  it("aggs: control_aggs_schedule maps the action enum to the sub-path", async () => {
    const tools = build();
    for (const action of ["pause", "resume", "force-run"] as const) {
      apiCalls = [];
      await tools.get("drh_control_aggs_schedule")!.handler({ aggsScheduleId: "agg1", action }, { authInfo: undefined });
      expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/aggs/schedule/agg1/${action}`);
    }
  });

  it("aggs: update is PUT on the id path; templates hits the fixed sub-path", async () => {
    const tools = build();
    await tools.get("drh_update_aggs_schedule")!.handler({ aggsScheduleId: "a2", body: {} }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("PUT");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/aggs/schedule/a2`);
    apiCalls = [];
    await tools.get("drh_list_aggs_job_templates")!.handler({}, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/aggs/schedule/aggs-job-templates`);
  });

  it("automation-logs: search is POST /automations/search; delete uses the test sub-path", async () => {
    const tools = build();
    await tools.get("drh_search_automation_logs")!.handler({ body: { q: 1 } }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("POST");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/automations/search`);
    apiCalls = [];
    await tools.get("drh_delete_automation_log")!.handler({ automationId: "log-3" }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("DELETE");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/automations/test/log-3`);
    apiCalls = [];
    await tools.get("drh_get_automation_log")!.handler({ automationId: "log-3" }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/automations/log-3`);
  });

  it("data-qualities: get + delete pass databaseId as a query param", async () => {
    const tools = build();
    await tools.get("drh_get_data_quality")!.handler({ databaseId: 12 }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("GET");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/data-qualities?databaseId=12`);
    apiCalls = [];
    await tools.get("drh_delete_data_quality")!.handler({ databaseId: 12 }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("DELETE");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/data-qualities?databaseId=12`);
  });

  it("data-qualities: hygiene-scores includes optional count in the query", async () => {
    const tools = build();
    await tools.get("drh_get_hygiene_scores")!.handler({ databaseId: 3, count: 5 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/data-qualities/hygiene-scores?databaseId=3&count=5`);
  });

  it("subject-areas: upsert is PUT; get url-encodes the string id", async () => {
    const tools = build();
    await tools.get("drh_upsert_subject_area")!.handler({ body: { name: "sa" } }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("PUT");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/subject-areas`);
    apiCalls = [];
    await tools.get("drh_get_subject_area")!.handler({ subjectAreaId: "cust profile" }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/subject-areas/cust%20profile`);
  });

  it("subject-areas: columns returns raw CSV text", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (String(url).includes("/auth/signon"))
        return new Response(JSON.stringify({ token: "proxy-1" }), { status: 200 });
      return new Response("col\nval", { status: 200 });
    }) as unknown as typeof fetch;
    const tools = build();
    const res: any = await tools.get("drh_get_subject_area_columns")!.handler({ subjectAreaId: "sa1" }, { authInfo: undefined });
    expect(res.content[0].text).toBe("col\nval");
  });

  it("runs: control_match_run_schedule maps the action enum to the sub-path", async () => {
    const tools = build();
    for (const action of ["pause", "resume", "force-run"] as const) {
      apiCalls = [];
      await tools.get("drh_control_match_run_schedule")!.handler({ action }, { authInfo: undefined });
      expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/match-runs/schedule/${action}`);
    }
  });

  it("runs: get_feed_run_record_metrics + search_feed_runs paths", async () => {
    const tools = build();
    await tools.get("drh_get_feed_run_record_metrics")!.handler({ feedRunId: 8 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feed-runs/8/record-metrics`);
    apiCalls = [];
    await tools.get("drh_search_feed_runs")!.handler({ body: { pageSelector: { pageSize: 10 } } }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("POST");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feed-runs/search`);
  });

  it("feeds: list_feeds forwards databaseId/sourceId; get_feed_version → versioned path", async () => {
    const tools = build();
    await tools.get("drh_list_feeds")!.handler({ databaseId: 1 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feeds?databaseId=1`);
    apiCalls = [];
    await tools.get("drh_get_feed_version")!.handler({ feedId: 4, versionNumber: 2 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feeds/4/versions/2`);
  });

  it("flat lists forward their required scoping query params", async () => {
    const tools = build();
    // sources requires databaseId
    await tools.get("drh_list_sources")!.handler({ databaseId: 3 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/sources?databaseId=3`);
    // feed-runs requires feedId (count optional)
    apiCalls = [];
    await tools.get("drh_list_feed_runs")!.handler({ feedId: 8, count: 5 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feed-runs?feedId=8&count=5`);
    // feeds accepts sourceId as the alternative scope
    apiCalls = [];
    await tools.get("drh_list_feeds")!.handler({ sourceId: 9 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feeds?sourceId=9`);
  });

  it("database-scoped tools default the databaseId to the configured default when omitted", async () => {
    const tools = build(); // client built with defaultDatabaseId=1
    // flat list: no databaseId → injected default
    await tools.get("drh_list_sources")!.handler({}, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/sources?databaseId=1`);
    // feeds: neither databaseId nor sourceId → injected default
    apiCalls = [];
    await tools.get("drh_list_feeds")!.handler({}, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feeds?databaseId=1`);
    // data-quality read: no databaseId → injected default
    apiCalls = [];
    await tools.get("drh_get_data_quality")!.handler({}, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/data-qualities?databaseId=1`);
    // UI/dashboard path-scoped read: no databaseId → default in the path
    apiCalls = [];
    await tools.get("drh_get_database_summary")!.handler({}, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/1/summary`);
    // explicit databaseId still wins over the default
    apiCalls = [];
    await tools.get("drh_get_database_summary")!.handler({ databaseId: 7 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/7/summary`);
  });

  it("feeds: get_feed_columns returns raw CSV text (not JSON-wrapped)", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (String(url).includes("/auth/signon"))
        return new Response(JSON.stringify({ token: "proxy-1" }), { status: 200 });
      return new Response("colA,colB\n1,2", { status: 200 });
    }) as unknown as typeof fetch;
    const tools = build();
    const res: any = await tools.get("drh_get_feed_columns")!.handler({ feedId: 9 }, { authInfo: undefined });
    expect(res.content[0].text).toBe("colA,colB\n1,2");
  });

  it("feeds: set_feed_automation_paused uses SINGULAR pause-automation sub-path", async () => {
    const tools = build();
    await tools.get("drh_set_feed_automation_paused")!.handler({ feedId: 3, paused: true }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feeds/3/pause-automation`);
    apiCalls = [];
    await tools.get("drh_set_feed_automation_paused")!.handler({ feedId: 3, paused: false }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/feeds/3/resume-automation`);
  });

  it("list_databases → GET /databases with Bearer proxy token + default X-ClientId", async () => {
    const tools = build();
    await tools.get("drh_list_databases")!.handler({}, { authInfo: undefined });
    const c = apiCalls[0];
    expect(c.method).toBe("GET");
    expect(c.url).toBe(`${BASE}/api-op/v1/databases`);
    expect(c.headers.Authorization).toBe("Bearer proxy-1");
    expect(c.headers["X-ClientId"]).toBe("tenant-default");
  });

  it("get_database_by_id → GET /databases/{id}", async () => {
    const tools = build();
    await tools.get("drh_get_database_by_id")!.handler({ databaseId: 5 }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/5`);
  });

  it("create_database → POST /databases with JSON body", async () => {
    const tools = build();
    await tools.get("drh_create_database")!.handler({ body: { name: "db1" } }, { authInfo: undefined });
    const c = apiCalls[0];
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${BASE}/api-op/v1/databases`);
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(c.body!)).toEqual({ name: "db1" });
  });

  it("set_database_automations_paused consolidates pause/resume by boolean", async () => {
    const tools = build();
    await tools.get("drh_set_database_automations_paused")!.handler({ databaseId: 3, paused: true }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/3/pause-automations`);
    apiCalls = [];
    await tools.get("drh_set_database_automations_paused")!.handler({ databaseId: 3, paused: false }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/databases/3/resume-automations`);
  });

  it("set_source_enabled consolidates enable/disable by boolean", async () => {
    const tools = build();
    await tools.get("drh_set_source_enabled")!.handler({ sourceId: 9, enabled: true }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/sources/9/enable`);
    apiCalls = [];
    await tools.get("drh_set_source_enabled")!.handler({ sourceId: 9, enabled: false }, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/sources/9/disable`);
  });

  it("delete_source → DELETE /sources/{id}", async () => {
    const tools = build();
    await tools.get("drh_delete_source")!.handler({ sourceId: 7 }, { authInfo: undefined });
    expect(apiCalls[0].method).toBe("DELETE");
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/sources/7`);
  });

  it("verify_connection → GET /healthcheck/version", async () => {
    const tools = build();
    await tools.get("drh_verify_connection")!.handler({}, { authInfo: undefined });
    expect(apiCalls[0].url).toBe(`${BASE}/api-op/v1/healthcheck/version`);
  });

  it("clientId override wins over the default; per-user token used over proxy", async () => {
    const tools = build();
    await tools
      .get("drh_list_sources")!
      .handler({ clientId: "tenant-X" }, { authInfo: { token: "user-tok" } });
    const c = apiCalls[0];
    expect(c.headers["X-ClientId"]).toBe("tenant-X");
    expect(c.headers.Authorization).toBe("Bearer user-tok");
  });
});
