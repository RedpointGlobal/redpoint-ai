/**
 * #27897 — LOCAL mirror of the chart-spec contract for the web renderer.
 *
 * apps/web deliberately does NOT import the @redpoint-ai/shared *package*
 * (Next/webpack workspace-package traversal hiccup — see rpi-url-allowlist.ts /
 * version.ts), so the type is mirrored here. The AUTHORITATIVE contract + the
 * strict Zod validation live in packages/shared/src/schemas/chart.ts and run on
 * the server (render_chart). This file is the frontend's structural view of the
 * validated args + the pure rendering-plan derivation, kept in sync by hand.
 */

export const CHART_TYPES = ["bar", "line", "area", "pie", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  data: Array<Record<string, string | number | null>>;
  xKey: string;
  yKeys: string[];
  stacked?: boolean;
  /** Dashboard-panel column span (#27897 followup) — see the shared ChartSpec. */
  colSpan?: number;
  orientation?: "vertical" | "horizontal";
  innerRadius?: number;
  showLegend?: boolean;
  showGrid?: boolean;
  xAxisLabel?: string;
  yAxisLabel?: string;
}

/** Defensive guard — the server already validated, but never render malformed args. */
export function isChartSpec(x: unknown): x is ChartSpec {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.type === "string" &&
    (CHART_TYPES as readonly string[]).includes(s.type) &&
    Array.isArray(s.data) &&
    s.data.length > 0 &&
    typeof s.xKey === "string" &&
    s.xKey.length > 0 &&
    Array.isArray(s.yKeys) &&
    s.yKeys.length > 0 &&
    s.yKeys.every((k) => typeof k === "string")
  );
}

/** The deterministic rendering plan derived from a spec — the testable core. */
export interface ChartLayout {
  kind: ChartType;
  xKey: string;
  series: string[];
  /** pie with innerRadius > 0 renders as a doughnut. */
  isDoughnut: boolean;
  /** stacking only applies to bar/area. */
  stacked: boolean;
  /** horizontal bar (bar + orientation "horizontal") — swaps the axes. */
  isHorizontal: boolean;
  /** legend shown: explicit, else default (pie, or ≥2 series — never color-alone identity). */
  showLegend: boolean;
  /** cartesian grid: explicit, else on for cartesian types, off for pie. */
  showGrid: boolean;
  innerRadiusPct: number;
}

export function chartLayout(spec: ChartSpec): ChartLayout {
  const kind = spec.type;
  const series = spec.yKeys;
  const isCartesian = kind === "bar" || kind === "line" || kind === "area" || kind === "scatter";
  const isDoughnut = kind === "pie" && (spec.innerRadius ?? 0) > 0;
  return {
    kind,
    xKey: spec.xKey,
    series,
    isDoughnut,
    stacked: !!spec.stacked && (kind === "bar" || kind === "area"),
    isHorizontal: kind === "bar" && spec.orientation === "horizontal",
    // dataviz: a legend is present for ≥2 series (identity never color-alone); a
    // single series needs none (the title names it). Pie always legends its slices.
    showLegend: spec.showLegend ?? (kind === "pie" || series.length >= 2),
    showGrid: spec.showGrid ?? isCartesian,
    innerRadiusPct: isDoughnut ? (spec.innerRadius ?? 0) : 0,
  };
}
