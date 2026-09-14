import { z } from "zod";

/**
 * #27897 (Approach B) — the CHART SPEC contract shared by the render_chart tool
 * (apps/server, validation) and <AgentChart> (apps/web, Recharts rendering).
 *
 * The agent emits a schema-validated chart JSON after pulling data via existing
 * RPI/DRH tools — never JS. This is the stable contract both sides depend on;
 * additional Recharts knobs are added as fields incrementally.
 *
 * Doughnut = `type: "pie"` + `innerRadius`. Dual-axis is deliberately NOT a field
 * (the dataviz design system forbids two y-scales — two measures → two charts).
 */

export const CHART_TYPES = ["bar", "line", "area", "pie", "scatter"] as const;
export const ChartTypeSchema = z.enum(CHART_TYPES);
export type ChartType = (typeof CHART_TYPES)[number];

/** One data point — a flat record of the x field + each series/value field. */
const ChartDatumSchema = z.record(z.union([z.string(), z.number(), z.null()]));

export const ChartSpecSchema = z
  .object({
    /** Chart form. Doughnut = "pie" with innerRadius > 0. */
    type: ChartTypeSchema,
    /** Optional chart title shown above the plot. */
    title: z.string().max(200).optional(),
    /** Optional subtitle/caption under the title (e.g. the time range or scope). */
    subtitle: z.string().max(200).optional(),
    /** Row-oriented data from the agent's prior tool result. Each row is one point. */
    data: z.array(ChartDatumSchema).min(1, "data must have at least one row"),
    /**
     * The category / name / x field key present in each data row:
     * bar/line/area = category (x axis); pie = slice name; scatter = numeric x.
     */
    xKey: z.string().min(1),
    /**
     * The value / series / y field key(s) to plot:
     * bar/line/area = one per series; pie = exactly one (the slice value);
     * scatter = one numeric y (extras allowed for multi-series scatter).
     */
    yKeys: z.array(z.string().min(1)).min(1, "at least one yKey is required"),
    /** Stack the series (bar/area only). Ignored by other types. */
    stacked: z.boolean().optional(),
    /**
     * Dashboard-panel column span (#27897 followup). How many of the dashboard's
     * `columns` this panel occupies in the EXPANDED grid — e.g. colSpan 2 in a
     * 2-column dashboard = a full-width row. Enables asymmetric layouts (a
     * full-width chart above an uneven row — e.g. a 5-col grid with a 3-wide
     * chart beside a 2-wide one = 60/40). Clamped to the dashboard's column count;
     * ignored inline (panels always stack 1-up in the narrow chat column) and for
     * a standalone chart.
     */
    colSpan: z.number().int().min(1).max(6).optional(),
    /** Bar orientation: "vertical" (default, columns) or "horizontal" (bars). Bar only. */
    orientation: z.enum(["vertical", "horizontal"]).default("vertical"),
    /** Pie inner-radius as a percentage 0–99 → a doughnut when > 0. Pie only. */
    innerRadius: z.number().int().min(0).max(99).optional(),
    /** Show the series legend (default: renderer decides by series count). */
    showLegend: z.boolean().optional(),
    /** Show the cartesian grid (bar/line/area/scatter). */
    showGrid: z.boolean().optional(),
    /** Axis titles (cartesian types). */
    xAxisLabel: z.string().max(120).optional(),
    yAxisLabel: z.string().max(120).optional(),
  })
  .strict()
  .refine((s) => s.type !== "pie" || s.yKeys.length === 1, {
    message: "pie/doughnut uses exactly one yKey (the slice value)",
    path: ["yKeys"],
  })
  .refine((s) => s.innerRadius === undefined || s.type === "pie", {
    message: "innerRadius applies only to type 'pie' (making it a doughnut)",
    path: ["innerRadius"],
  })
  .refine((s) => s.orientation === "vertical" || s.type === "bar", {
    message: "orientation 'horizontal' applies only to type 'bar'",
    path: ["orientation"],
  })
  .refine(
    (s) => {
      // The declared keys must exist in the data (checked against the first row —
      // enough to catch an agent naming a column that isn't there).
      const first = s.data[0] ?? {};
      return [s.xKey, ...s.yKeys].every((k) => k in first);
    },
    { message: "xKey and every yKey must be present in the data rows", path: ["data"] },
  );

export type ChartSpec = z.infer<typeof ChartSpecSchema>;
