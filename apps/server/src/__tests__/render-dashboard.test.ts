/**
 * #27957 (Phase 2) — render_view_dashboard (single dispatcher) + the run-counts
 * view. The LLM picks a viewId + params; the server fetches (dataSource) and
 * assembles the spec (templateFn, PURE) and RETURNS it. Tests lock:
 *   - templateFn purity + the data→DashboardSpec mapping (buckets→stacked bar,
 *     overall modes→donut, totals→tiles), and fail-shaping (bad/empty → valid spec);
 *   - parseToolResult (MCP content-wrapped / plain / garbage → structured, no throw);
 *   - the view registry presence;
 *   - the dispatcher: unknown viewId / bad params → rejection; happy path → a
 *     schema-valid DashboardSpec assembled from a stubbed data tool.
 */
import { describe, it, expect } from "bun:test";
import { DashboardSpecSchema } from "@redpoint-ai/shared";
import { createRenderViewDashboardTool } from "../agents/render-dashboard.js";
import { viewRegistry, viewIds } from "../agents/dashboards/registry.js";
import {
  templateFn,
  parseToolResult,
  runCountsParamsSchema,
  type RunCountsData,
  type RunCountsParams,
} from "../agents/dashboards/interaction-run-counts.js";

const PARAMS: RunCountsParams = runCountsParamsSchema.parse({
  fromDate: "2026-08-01",
  toDate: "2026-08-31",
});

const DATA: RunCountsData = {
  results: [
    { date: "2026-08-01", executionModes: [{ executionMode: "Production", resultsCount: 5 }, { executionMode: "Test", resultsCount: 2 }], totalRuns: 7 },
    { date: "2026-08-02", executionModes: [{ executionMode: "Production", resultsCount: 3 }], totalRuns: 3 },
  ],
  executionModes: [{ executionMode: "Production", resultsCount: 8 }, { executionMode: "Test", resultsCount: 2 }],
  totalRuns: 10,
};

const execTool = (t: unknown, a: unknown) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(a, {
    toolCallId: "t",
    messages: [],
  });

describe("interaction-run-counts templateFn (PURE data → DashboardSpec)", () => {
  it("is a pure function: same (data, params) → byte-identical spec", () => {
    const a = JSON.stringify(templateFn(DATA, PARAMS));
    const b = JSON.stringify(templateFn(DATA, PARAMS));
    expect(a).toBe(b);
  });

  it("emits a schema-valid spec in the approved 5-col grid (bar 5 / area 3 / donut 2)", () => {
    const spec = templateFn(DATA, PARAMS);
    expect(DashboardSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.panels).toHaveLength(3);
    expect(spec.columns).toBe(5);
    expect(spec.panels.map((p) => p.colSpan)).toEqual([5, 3, 2]); // full-width bar, then 60/40
  });

  it("buckets → a full-width stacked bar keyed by date, one series per execution mode", () => {
    const bar = templateFn(DATA, PARAMS).panels[0];
    expect(bar.type).toBe("bar");
    expect(bar.stacked).toBe(true);
    expect(bar.colSpan).toBe(5);
    expect(bar.xKey).toBe("date");
    expect(bar.yKeys).toEqual(["Production", "Test"]); // stable known order
    expect(bar.data).toEqual([
      { date: "2026-08-01", Production: 5, Test: 2 },
      { date: "2026-08-02", Production: 3, Test: 0 }, // missing mode → 0, not dropped
    ]);
  });

  it("area panel = per-day test/prod (2 series, NOT stacked, NOT cumulative) reusing the bar rows", () => {
    const spec = templateFn(DATA, PARAMS);
    const area = spec.panels[1];
    expect(area.type).toBe("area");
    expect(area.stacked).toBe(false);
    expect(area.colSpan).toBe(3);
    expect(area.xKey).toBe("date");
    expect(area.yKeys).toEqual(["Production", "Test"]); // same series as the bar
    expect(area.data).toEqual(spec.panels[0].data); // literally the bar rows
  });

  it("overall executionModes → a test-vs-production donut (right, colSpan 2)", () => {
    const donut = templateFn(DATA, PARAMS).panels[2];
    expect(donut.type).toBe("pie");
    expect(donut.innerRadius).toBeGreaterThan(0);
    expect(donut.colSpan).toBe(2);
    expect(donut.data).toEqual([
      { mode: "Production", count: 8 },
      { mode: "Test", count: 2 },
    ]);
  });

  it("totals → tiles (total runs, buckets-with-runs, production, test)", () => {
    const tiles = templateFn(DATA, PARAMS).tiles!;
    const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t.value]));
    expect(byLabel["Total runs"]).toBe("10");
    expect(byLabel["days with runs"]).toBe("2");
    expect(byLabel["Production runs"]).toBe("8");
    expect(byLabel["Test runs"]).toBe("2");
  });

  it("FAIL-SHAPING: empty response → a valid spec (zeroes), never throws", () => {
    const spec = templateFn({}, PARAMS);
    expect(DashboardSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.panels[0].data).toHaveLength(1); // one zero row keyed by fromDate
    expect(spec.tiles![0].value).toBe("0");
  });

  it("FAIL-SHAPING: partial/garbage buckets → still a valid spec", () => {
    const spec = templateFn(
      { results: [{ date: null, executionModes: null, totalRuns: null } as never], totalRuns: null },
      PARAMS,
    );
    expect(DashboardSpecSchema.safeParse(spec).success).toBe(true);
  });
});

describe("parseToolResult (MCP result → structured, no throw)", () => {
  it("extracts + JSON-parses the MCP text content part", () => {
    const wrapped = { content: [{ type: "text", text: JSON.stringify(DATA) }] };
    expect(parseToolResult(wrapped)).toEqual(DATA);
  });
  it("passes a plain structured object through", () => {
    expect(parseToolResult(DATA)).toEqual(DATA);
  });
  it("parses a bare JSON string", () => {
    expect(parseToolResult(JSON.stringify(DATA))).toEqual(DATA);
  });
  it("bad/garbage payload → {} (never throws)", () => {
    expect(parseToolResult({ content: [{ type: "text", text: "not json" }] })).toEqual({});
    expect(parseToolResult(null)).toEqual({});
    expect(parseToolResult(42)).toEqual({});
  });
});

describe("view registry", () => {
  it("registers the interaction-run-counts view", () => {
    expect(viewIds).toContain("interaction-run-counts");
    expect(viewRegistry["interaction-run-counts"]?.templateFn).toBeTypeOf("function");
    expect(viewRegistry["interaction-run-counts"]?.dataSource).toBeTypeOf("function");
  });
});

describe("render_view_dashboard dispatcher", () => {
  const stubCtx = {
    mcpTools: {
      rpi__get_interaction_run_counts: {
        execute: async () => ({ content: [{ type: "text", text: JSON.stringify(DATA) }] }),
      },
    },
  } as never;

  it("has a jsonSchema inputSchema (LLM-facing contract)", () => {
    const t = createRenderViewDashboardTool(stubCtx) as unknown as { inputSchema?: unknown };
    expect(t.inputSchema).toBeDefined();
  });

  it("unknown viewId → rejection naming the available views", async () => {
    const t = createRenderViewDashboardTool(stubCtx);
    const msg = await execTool(t, { viewId: "nope", params: {} });
    expect(String(msg)).toMatch(/unknown viewid/i);
    expect(String(msg)).toContain("interaction-run-counts");
  });

  it("bad params → rejection, not a render", async () => {
    const t = createRenderViewDashboardTool(stubCtx);
    const msg = await execTool(t, { viewId: "interaction-run-counts", params: { fromDate: "2026-08-01" } });
    expect(String(msg)).toMatch(/params rejected/i);
  });

  it("missing data tool → a clean 'could not load' message", async () => {
    const t = createRenderViewDashboardTool({ mcpTools: {} } as never);
    const msg = await execTool(t, {
      viewId: "interaction-run-counts",
      params: { fromDate: "2026-08-01", toDate: "2026-08-31" },
    });
    expect(String(msg)).toMatch(/could not load data/i);
  });

  it("happy path → returns a schema-valid DashboardSpec (from the stubbed tool)", async () => {
    const t = createRenderViewDashboardTool(stubCtx);
    const res = await execTool(t, {
      viewId: "interaction-run-counts",
      params: { fromDate: "2026-08-01", toDate: "2026-08-31", granularity: "Day", executionMode: "All" },
    });
    expect(typeof res).toBe("object");
    expect(DashboardSpecSchema.safeParse(res).success).toBe(true);
    expect((res as { panels: unknown[] }).panels).toHaveLength(3);
  });
});
