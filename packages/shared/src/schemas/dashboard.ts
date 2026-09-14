import { z } from "zod";
import { ChartSpecSchema } from "./chart.js";
import { StatTileSchema } from "./stats.js";

/**
 * #27897 (P2) — the DASHBOARD contract. Emitted by a view's `templateFn` and
 * re-validated by render_view_dashboard's execute (apps/server, #27957 Phase 2),
 * then rendered by <AgentDashboard> (apps/web) from the tool result.
 *
 * A view: an optional header, an optional KPI stat-tile row, and one or more chart
 * panels. Reuses the existing StatTile and ChartSpec contracts as its building
 * blocks, so the tiles and panels render with the exact same primitives (and
 * theming) as when emitted standalone.
 *
 * Layout is responsive by CONTAINER, not viewport: inline it stacks 1-up
 * (readable in the narrow chat column); expanded it lays the panels out in
 * `columns` side-by-side. `columns` is the EXPANDED grid width only.
 */

export const DashboardSpecSchema = z
  .object({
    /** Optional dashboard title shown at the top. */
    title: z.string().max(200).optional(),
    /** Optional subtitle/caption under the title (e.g. the date range). */
    subtitle: z.string().max(200).optional(),
    /** Optional headline KPI tiles, rendered as a row above the panels. */
    tiles: z.array(StatTileSchema).max(12).optional(),
    /** The chart panels, in display order. At least one. */
    panels: z.array(ChartSpecSchema).min(1, "a dashboard needs at least one chart panel").max(12),
    /** Columns for the EXPANDED side-by-side grid (inline always stacks 1-up).
     *  Up to 6 so a fine grid can express uneven rows via panel colSpan (e.g.
     *  columns 5 with a 3-wide + 2-wide row = 60/40). */
    columns: z.number().int().min(1).max(6).default(2),
  })
  .strict();

export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;
