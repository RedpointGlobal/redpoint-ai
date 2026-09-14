/**
 * #27897 — the chart-spec contract. Locks the shape both the render_chart tool
 * and <AgentChart> depend on: each P1 type validates, and the strict rules
 * (pie→1 yKey, innerRadius pie-only, keys-exist, no extra props) reject.
 */
import { describe, it, expect } from "bun:test";
import { ChartSpecSchema, CHART_TYPES } from "../schemas/chart.js";

const rows = [
  { segment: "A", count: 10, revenue: 100 },
  { segment: "B", count: 20, revenue: 250 },
];

const base = { data: rows, xKey: "segment", yKeys: ["count"] };

describe("ChartSpecSchema — valid", () => {
  it("bar with multiple series", () => {
    expect(ChartSpecSchema.safeParse({ ...base, type: "bar", yKeys: ["count", "revenue"] }).success).toBe(true);
  });
  it("stacked area", () => {
    expect(ChartSpecSchema.safeParse({ ...base, type: "area", stacked: true }).success).toBe(true);
  });
  it("line with title + axis labels", () => {
    expect(
      ChartSpecSchema.safeParse({ ...base, type: "line", title: "Trend", xAxisLabel: "Seg", yAxisLabel: "Count" }).success,
    ).toBe(true);
  });
  it("pie with exactly one yKey", () => {
    expect(ChartSpecSchema.safeParse({ ...base, type: "pie" }).success).toBe(true);
  });
  it("doughnut = pie + innerRadius", () => {
    expect(ChartSpecSchema.safeParse({ ...base, type: "pie", innerRadius: 50 }).success).toBe(true);
  });
  it("scatter", () => {
    expect(ChartSpecSchema.safeParse({ ...base, type: "scatter", xKey: "count", yKeys: ["revenue"] }).success).toBe(true);
  });
  it("exposes the five P1 types", () => {
    expect([...CHART_TYPES].sort()).toEqual(["area", "bar", "line", "pie", "scatter"]);
  });
  it("accepts an optional subtitle (P2 card header)", () => {
    expect(
      ChartSpecSchema.safeParse({ ...base, type: "bar", title: "Runs", subtitle: "Last 30 days" }).success,
    ).toBe(true);
  });
  it("subtitle is optional — omitting it is valid", () => {
    const parsed = ChartSpecSchema.safeParse({ ...base, type: "bar" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.subtitle).toBeUndefined();
  });
  it("horizontal orientation on a bar", () => {
    expect(ChartSpecSchema.safeParse({ ...base, type: "bar", orientation: "horizontal" }).success).toBe(true);
  });
  it("orientation defaults to vertical when omitted", () => {
    const p = ChartSpecSchema.safeParse({ ...base, type: "bar" });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.orientation).toBe("vertical");
  });
});

describe("ChartSpecSchema — reject", () => {
  const bad = (spec: unknown) => ChartSpecSchema.safeParse(spec);

  it("pie with >1 yKey", () => {
    const r = bad({ ...base, type: "pie", yKeys: ["count", "revenue"] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /pie/.test(i.message))).toBe(true);
  });
  it("innerRadius on a non-pie type", () => {
    expect(bad({ ...base, type: "bar", innerRadius: 40 }).success).toBe(false);
  });
  it("horizontal orientation on a non-bar type", () => {
    expect(bad({ ...base, type: "line", orientation: "horizontal" }).success).toBe(false);
  });
  it("xKey not present in the data rows", () => {
    expect(bad({ ...base, type: "bar", xKey: "missing" }).success).toBe(false);
  });
  it("a yKey not present in the data rows", () => {
    expect(bad({ ...base, type: "bar", yKeys: ["count", "nope"] }).success).toBe(false);
  });
  it("empty data", () => {
    expect(bad({ type: "bar", data: [], xKey: "segment", yKeys: ["count"] }).success).toBe(false);
  });
  it("empty yKeys", () => {
    expect(bad({ ...base, type: "bar", yKeys: [] }).success).toBe(false);
  });
  it("unknown chart type", () => {
    expect(bad({ ...base, type: "sankey" }).success).toBe(false);
  });
  it("unknown/extra field (strict)", () => {
    expect(bad({ ...base, type: "bar", dualAxis: true }).success).toBe(false);
  });
  it("innerRadius out of range", () => {
    expect(bad({ ...base, type: "pie", innerRadius: 100 }).success).toBe(false);
  });
});
