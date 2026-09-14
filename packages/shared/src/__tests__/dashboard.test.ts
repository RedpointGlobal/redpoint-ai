/**
 * #27897 (P2) — the dashboard contract. Locks the composed shape render_dashboard
 * and <AgentDashboard> depend on: panels required (≥1), tiles optional, columns
 * defaulted + bounded, and the reused ChartSpec/StatTile rules still enforced.
 */
import { describe, it, expect } from "bun:test";
import { DashboardSpecSchema } from "../schemas/dashboard.js";

const rows = [
  { day: "Mon", runs: 10 },
  { day: "Tue", runs: 20 },
];
const panel = { type: "bar" as const, data: rows, xKey: "day", yKeys: ["runs"] };

describe("DashboardSpecSchema — valid", () => {
  it("tiles + panels + header, columns defaults to 2", () => {
    const p = DashboardSpecSchema.safeParse({
      title: "Runs",
      subtitle: "This month",
      tiles: [{ value: "385", label: "Runs" }],
      panels: [panel],
    });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.columns).toBe(2);
  });
  it("panels only (tiles optional)", () => {
    expect(DashboardSpecSchema.safeParse({ panels: [panel] }).success).toBe(true);
  });
  it("multiple panels + explicit columns", () => {
    expect(
      DashboardSpecSchema.safeParse({ panels: [panel, panel, panel], columns: 3 }).success,
    ).toBe(true);
  });
  it("asymmetric layout via panel colSpan (full-width top + 2-up row)", () => {
    // The daily dashboard: a full-width stacked bar (colSpan 2) over a 2-up row.
    const p = DashboardSpecSchema.safeParse({
      columns: 2,
      panels: [
        { ...panel, colSpan: 2 },
        { ...panel, colSpan: 1 },
        { type: "pie" as const, data: [{ segment: "a", count: 1 }], xKey: "segment", yKeys: ["count"], colSpan: 1 },
      ],
    });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.panels[0].colSpan).toBe(2);
  });
  it("uneven 60/40 row via a 5-col grid (bar 5, area 3, donut 2)", () => {
    const p = DashboardSpecSchema.safeParse({
      columns: 5,
      panels: [
        { ...panel, colSpan: 5 },
        { ...panel, colSpan: 3 },
        { type: "pie" as const, data: [{ segment: "a", count: 1 }], xKey: "segment", yKeys: ["count"], colSpan: 2 },
      ],
    });
    expect(p.success).toBe(true);
  });
  it("colSpan out of range is rejected", () => {
    expect(DashboardSpecSchema.safeParse({ panels: [{ ...panel, colSpan: 7 }] }).success).toBe(false);
    expect(DashboardSpecSchema.safeParse({ panels: [{ ...panel, colSpan: 0 }] }).success).toBe(false);
  });
});

describe("DashboardSpecSchema — reject", () => {
  it("no panels", () => {
    expect(DashboardSpecSchema.safeParse({ panels: [] }).success).toBe(false);
    expect(DashboardSpecSchema.safeParse({ tiles: [{ value: "1", label: "x" }] }).success).toBe(false);
  });
  it("columns out of range", () => {
    expect(DashboardSpecSchema.safeParse({ panels: [panel], columns: 7 }).success).toBe(false);
    expect(DashboardSpecSchema.safeParse({ panels: [panel], columns: 0 }).success).toBe(false);
  });
  it("a malformed panel is rejected (reuses ChartSpec rules)", () => {
    const badPanel = { type: "pie", data: rows, xKey: "day", yKeys: ["runs", "extra"] };
    expect(DashboardSpecSchema.safeParse({ panels: [badPanel] }).success).toBe(false);
  });
  it("a malformed tile is rejected (reuses StatTile rules)", () => {
    expect(
      DashboardSpecSchema.safeParse({ tiles: [{ label: "no value" }], panels: [panel] }).success,
    ).toBe(false);
  });
  it("unknown/extra field (strict)", () => {
    expect(DashboardSpecSchema.safeParse({ panels: [panel], layout: "grid" }).success).toBe(false);
  });
});
