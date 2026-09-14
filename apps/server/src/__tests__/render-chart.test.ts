/**
 * #27897 — render_chart tool. Its inputSchema is derived from the shared Zod
 * ChartSpecSchema, and execute strictly re-validates (the Zod .refine()s the JSON
 * Schema can't express). Valid spec → confirmation; invalid → an actionable
 * rejection the agent can retry against.
 */
import { describe, it, expect } from "bun:test";
import { createRenderChartTool, CHART_STEERING } from "../agents/render-chart.js";

const rows = [
  { segment: "A", count: 10 },
  { segment: "B", count: 20 },
];

const call = (spec: unknown) =>
  (createRenderChartTool() as unknown as {
    execute: (a: unknown, o: unknown) => Promise<string>;
  }).execute(spec, {});

describe("render_chart tool", () => {
  it("has a jsonSchema inputSchema (LLM-facing contract)", () => {
    const t = createRenderChartTool() as unknown as { inputSchema?: unknown };
    expect(t.inputSchema).toBeDefined();
  });

  it("advertises horizontal bars in its description (ranking / long labels)", () => {
    const d = (createRenderChartTool() as unknown as { description: string }).description.toLowerCase();
    expect(d).toContain("horizontal");
    expect(d).toContain("orientation");
  });

  it("valid bar spec → confirmation naming type + series", async () => {
    const msg = await call({ type: "bar", data: rows, xKey: "segment", yKeys: ["count"] });
    expect(msg).toMatch(/rendered a bar chart/i);
    expect(msg).toContain("count");
    expect(msg).toContain("2 point(s)");
  });

  it("pie + innerRadius → reported as a doughnut", async () => {
    const msg = await call({ type: "pie", data: rows, xKey: "segment", yKeys: ["count"], innerRadius: 50 });
    expect(msg).toMatch(/doughnut/i);
  });

  it("invalid (pie with 2 yKeys) → rejection, not a render", async () => {
    const msg = await call({ type: "pie", data: rows, xKey: "segment", yKeys: ["count", "x"] });
    expect(msg).toMatch(/rejected/i);
    expect(msg).toMatch(/render_chart again/i);
  });

  it("invalid (key not in data) → rejection", async () => {
    const msg = await call({ type: "bar", data: rows, xKey: "nope", yKeys: ["count"] });
    expect(msg).toMatch(/rejected/i);
  });
});

describe("CHART_STEERING (Bug 1 — chart-request → render_chart call)", () => {
  it("names render_chart as a MUST on a chart request", () => {
    expect(CHART_STEERING).toContain("render_chart");
    expect(CHART_STEERING).toMatch(/MUST/);
  });

  it("covers the request vocabulary (chart/graph/plot/visualize)", () => {
    for (const w of ["chart", "graph", "plot", "visualize"]) {
      expect(CHART_STEERING.toLowerCase()).toContain(w);
    }
  });

  it("forbids the observed failure mode: table-only + defer to an external tool", () => {
    expect(CHART_STEERING.toLowerCase()).toContain("markdown table");
    expect(CHART_STEERING.toLowerCase()).toMatch(/external|preferred visualization/);
  });

  it("tells the agent to fetch-then-chart (not require pre-fetched data)", () => {
    expect(CHART_STEERING.toLowerCase()).toContain("fetch the data first");
  });

  it("guards against OVER-triggering — a plain list/count/text stays text", () => {
    const lc = CHART_STEERING.toLowerCase();
    expect(lc).toContain("do not call render_chart");
    // Explicitly names the non-chart cases it must NOT fire on.
    expect(lc).toMatch(/plain list|a count|text answer/);
    // And states the fire condition is explicit chart intent, not "returns data".
    expect(lc).toContain("not on every request that happens to return data");
  });

  it("dashboard steering (#27957): overview/report/trend → render_view_dashboard", () => {
    const lc = CHART_STEERING.toLowerCase();
    // Triggers on dashboard/report/overview/trend vocabulary.
    for (const w of ["dashboard", "report", "overview", "trend"]) {
      expect(lc).toContain(w);
    }
    // Routes to the deterministic single dispatcher — NOT the retired composed tool.
    expect(lc).toContain("render_view_dashboard");
    expect(CHART_STEERING).not.toContain("render_dashboard");
    // The model picks viewId + params; it does NOT compose panels.
    expect(lc).toMatch(/viewid/);
    expect(lc).toMatch(/do not compose panels|you do not compose/);
  });

  it("never refuses to visualize (dashboards via render_view_dashboard, charts via render_chart)", () => {
    const lc = CHART_STEERING.toLowerCase();
    expect(lc).toMatch(/never tell the user you can't create a dashboard/);
  });

  it("drops the retired composed-dashboard steering (no render_dashboard / few-shot / daily 3-panel)", () => {
    // The compensatory composition prose is gone — determinism replaces it.
    expect(CHART_STEERING).not.toContain("render_dashboard");
    expect(CHART_STEERING).not.toContain("summarize_interaction_runs");
    expect(CHART_STEERING).not.toContain("EXACTLY THREE panels");
    expect(CHART_STEERING).not.toMatch(/granularity/i);
  });
});
