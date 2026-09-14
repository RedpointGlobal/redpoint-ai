import { z } from "zod";

/**
 * #27897 (P2) — the STAT-TILE (KPI) contract shared by the render_stats tool
 * (apps/server, validation) and <StatTiles> (apps/web, rendering).
 *
 * A dashboard building block: the agent emits a row of headline KPI tiles
 * (e.g. value "385", label "Runs this month", sub "332 test · 53 prod") which
 * render as a responsive card row in the chat, alongside the framed chart cards.
 * Like the chart spec, this is data + config only — never JS.
 *
 * `value` is a STRING so the agent controls the display formatting it already
 * knows how to produce ("385", "$1.2M", "98.6%", "1,204") — the renderer never
 * re-formats a number.
 */

export const StatTileSchema = z
  .object({
    /** The big headline figure, pre-formatted by the agent (e.g. "385", "$1.2M"). */
    value: z.string().min(1).max(40),
    /** What the figure measures (e.g. "Runs this month"). */
    label: z.string().min(1).max(80),
    /** Optional finer breakdown / caption under the label (e.g. "332 test · 53 prod"). */
    sub: z.string().max(120).optional(),
  })
  .strict();

export type StatTile = z.infer<typeof StatTileSchema>;

export const StatsSpecSchema = z
  .object({
    /** The KPI tiles, in display order. 1–12 keeps a row readable. */
    tiles: z.array(StatTileSchema).min(1, "at least one tile is required").max(12),
  })
  .strict();

export type StatsSpec = z.infer<typeof StatsSpecSchema>;
