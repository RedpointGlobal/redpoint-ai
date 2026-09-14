/**
 * #27897 — the pure chart rendering-plan (chartLayout) + spec guard. Locks the
 * deterministic decisions <AgentChart> renders from: series, doughnut, stacking,
 * and the dataviz legend/grid defaults.
 */
import { describe, it, expect } from "bun:test";
import { chartLayout, isChartSpec, type ChartSpec } from "../chart-spec";

const rows = [
  { seg: "A", count: 10, rev: 100 },
  { seg: "B", count: 20, rev: 250 },
];
const spec = (o: Partial<ChartSpec>): ChartSpec => ({ type: "bar", data: rows, xKey: "seg", yKeys: ["count"], ...o });

describe("chartLayout", () => {
  it("single-series cartesian → no legend by default, grid on", () => {
    const l = chartLayout(spec({ type: "line" }));
    expect(l.showLegend).toBe(false);
    expect(l.showGrid).toBe(true);
    expect(l.series).toEqual(["count"]);
  });

  it("multi-series → legend on by default (identity not color-alone)", () => {
    expect(chartLayout(spec({ type: "bar", yKeys: ["count", "rev"] })).showLegend).toBe(true);
  });

  it("explicit showLegend / showGrid override the defaults", () => {
    const l = chartLayout(spec({ type: "line", showLegend: true, showGrid: false }));
    expect(l.showLegend).toBe(true);
    expect(l.showGrid).toBe(false);
  });

  it("stacked applies only to bar/area", () => {
    expect(chartLayout(spec({ type: "bar", stacked: true })).stacked).toBe(true);
    expect(chartLayout(spec({ type: "area", stacked: true })).stacked).toBe(true);
    expect(chartLayout(spec({ type: "line", stacked: true })).stacked).toBe(false);
  });

  it("pie → legend on, grid off; doughnut only when innerRadius > 0", () => {
    const pie = chartLayout(spec({ type: "pie" }));
    expect(pie.showLegend).toBe(true);
    expect(pie.showGrid).toBe(false);
    expect(pie.isDoughnut).toBe(false);
    const dough = chartLayout(spec({ type: "pie", innerRadius: 50 }));
    expect(dough.isDoughnut).toBe(true);
    expect(dough.innerRadiusPct).toBe(50);
  });

  it("innerRadius on a non-pie is ignored (not a doughnut)", () => {
    const l = chartLayout(spec({ type: "bar", innerRadius: 40 }));
    expect(l.isDoughnut).toBe(false);
    expect(l.innerRadiusPct).toBe(0);
  });

  it("isHorizontal only for a bar with orientation 'horizontal'", () => {
    expect(chartLayout(spec({ type: "bar", orientation: "horizontal" })).isHorizontal).toBe(true);
    expect(chartLayout(spec({ type: "bar" })).isHorizontal).toBe(false);
    expect(chartLayout(spec({ type: "bar", orientation: "vertical" })).isHorizontal).toBe(false);
    // orientation on a non-bar never flips it (schema rejects it anyway).
    expect(chartLayout(spec({ type: "line", orientation: "horizontal" })).isHorizontal).toBe(false);
  });
});

describe("isChartSpec guard", () => {
  it("accepts a well-formed spec", () => {
    expect(isChartSpec(spec({}))).toBe(true);
  });
  it("rejects malformed / empty", () => {
    expect(isChartSpec(null)).toBe(false);
    expect(isChartSpec({ type: "bar", data: [], xKey: "seg", yKeys: ["count"] })).toBe(false);
    expect(isChartSpec({ type: "sankey", data: rows, xKey: "seg", yKeys: ["count"] })).toBe(false);
    expect(isChartSpec({ type: "bar", data: rows, xKey: "seg", yKeys: [] })).toBe(false);
    expect(isChartSpec({ type: "bar", data: rows, yKeys: ["count"] })).toBe(false); // no xKey
  });
});
