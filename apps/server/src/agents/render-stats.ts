/**
 * #27897 (P2) — the render_stats orchestrator tool.
 *
 * Companion to render_chart: the agent emits a row of KPI stat-tiles (a
 * schema-validated spec, never JS) and assistant-ui renders the tool call as
 * <StatTiles> from the tool ARGS. Same pattern as render_chart — the args ARE
 * the spec; this tool gives the model the schema to emit against and validates
 * strictly server-side.
 *
 * Single source of truth: the LLM-facing inputSchema is derived from the shared
 * Zod StatsSpecSchema (zod-to-json-schema), and the same Zod schema is the strict
 * validation gate in execute.
 */
import { tool, jsonSchema, type Tool } from "ai";
import { StatsSpecSchema } from "@redpoint-ai/shared";
import { zodToJsonSchema } from "zod-to-json-schema";

const statsInputSchema = zodToJsonSchema(StatsSpecSchema, {
  $refStrategy: "none",
  target: "jsonSchema7",
});

const DESCRIPTION =
  "Render a row of KPI stat-tiles (headline numbers) in the chat — the summary " +
  "cards atop a dashboard/overview. Use for a 'dashboard', 'overview', 'summary', " +
  "or 'key metrics' request, typically alongside render_chart. Fetch the figures " +
  "first if you don't have them, then call this with the tiles. Each tile: " +
  "`value` (the big figure, pre-formatted by you — '385', '$1.2M', '98.6%'), " +
  "`label` (what it measures — 'Runs this month'), and optional `sub` (a finer " +
  "breakdown — '332 test · 53 prod'). Emit a schema-validated spec, never code.";

export function createRenderStatsTool(): Tool {
  return tool({
    description: DESCRIPTION,
    inputSchema: jsonSchema(statsInputSchema as Record<string, unknown>),
    execute: async (spec: unknown) => {
      const parsed = StatsSpecSchema.safeParse(spec);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return `Stat-tiles rejected — ${issues}. Fix these and call render_stats again.`;
      }
      const { tiles } = parsed.data;
      return (
        `Rendered ${tiles.length} stat-tile(s) (${tiles.map((t) => t.label).join(", ")}). ` +
        `They are displayed in the chat; do not repeat the figures in text.`
      );
    },
  });
}
