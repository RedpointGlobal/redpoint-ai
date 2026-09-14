/**
 * #27897 (Approach B) — the render_chart orchestrator tool.
 *
 * The agent, AFTER pulling data via existing RPI/DRH tools, calls this with a
 * schema-validated chart spec (data + config, never JS). assistant-ui renders the
 * tool call as <AgentChart> from the tool ARGS, so this tool's job is to (a) give
 * the LLM the spec schema to emit against and (b) validate strictly server-side.
 * The return is a short confirmation for the agent's context; the spec itself is
 * carried to the frontend as the tool args.
 *
 * Single source of truth: the LLM-facing inputSchema is derived from the shared
 * Zod ChartSpecSchema (zod-to-json-schema), and the same Zod schema is the strict
 * validation gate in execute — no drift between contract, validation, and prompt.
 */
import { tool, jsonSchema, type Tool } from "ai";
import { ChartSpecSchema } from "@redpoint-ai/shared";
import { zodToJsonSchema } from "zod-to-json-schema";

// JSON Schema the model emits against. Zod .refine()s are runtime-only (not
// expressible in JSON Schema), so the strict rules (pie→1 yKey, keys-exist,
// no extra props) are enforced by the safeParse in execute; the description +
// this shape guide the model up front.
const chartInputSchema = zodToJsonSchema(ChartSpecSchema, {
  $refStrategy: "none",
  target: "jsonSchema7",
});

const DESCRIPTION =
  "Render a chart in the chat for any chart/plot/graph/visualize request. Fetch " +
  "the data first if you don't already have it (via the RPI/DRH tools), THEN call " +
  "this with the rows — do not return a table and tell the user to use another " +
  "tool. You emit a schema-validated spec (data + config), never code. Types: bar " +
  "(incl. stacked), line, area, pie, scatter — a doughnut is type 'pie' with " +
  "innerRadius > 0. xKey = the category/name/x column in your data rows; yKeys = " +
  "the value/series columns (pie uses exactly one). Pass the data rows as objects " +
  "keyed by those column names. Bar charts can be horizontal (set " +
  "orientation: 'horizontal') — best for ranking / top-N or long category labels.";

/**
 * Orchestrator system-prompt steering for charting. The tool description alone
 * didn't reliably trigger a call (Mark's first live test: the agent fetched the
 * data then returned a markdown table + "use your preferred visualization tool"
 * instead of calling render_chart, #27897). This makes the expectation explicit
 * in the system prompt. Appended unconditionally wherever render_chart is wired,
 * so it's present in every tier/workspace, not just skill workspaces.
 */
export const CHART_STEERING =
  "## Charts\n\n" +
  "When the user asks for a chart, graph, plot, or to visualize data — and you " +
  "have the data or can fetch it with your tools — you MUST call the " +
  "`render_chart` tool. Fetch the data first if needed, then build the spec from " +
  "the fetched rows: pick `type` (bar/line/area/pie/scatter), set `data` to the " +
  "rows, `xKey` to the category column, and `yKeys` to the value column(s). Never " +
  "answer a chart request with only a markdown table, and never tell the user to " +
  "use an external or preferred visualization tool — you render the chart " +
  "yourself via render_chart.\n\n" +
  "Only when a visual is asked for. Do NOT call render_chart for a request that " +
  "doesn't ask for one — a plain list, a count, or a request for a text answer " +
  "stays text. `render_chart` fires on explicit chart/graph/plot/visualize " +
  "intent, not on every request that happens to return data.\n\n" +
  "## Dashboards & reports\n\n" +
  "For a dashboard, report, overview, or trend request, call `render_view_dashboard` " +
  "with a `viewId` and its `params` — the server fetches the data and assembles the " +
  "view deterministically. You do NOT compose panels or author a layout; you only " +
  "pick the view and its params (e.g. a date range). See the tool's description for " +
  "the available views. It renders inline in the chat; do not repeat the figures in " +
  "text. NEVER tell the user you can't create a dashboard, report, or visualization — " +
  "`render_view_dashboard` (dashboards) and `render_chart` (single charts) ARE how " +
  "you create them.";

export function createRenderChartTool(): Tool {
  return tool({
    description: DESCRIPTION,
    inputSchema: jsonSchema(chartInputSchema as Record<string, unknown>),
    execute: async (spec: unknown) => {
      const parsed = ChartSpecSchema.safeParse(spec);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return `Chart spec rejected — ${issues}. Fix these and call render_chart again.`;
      }
      const s = parsed.data;
      const shape =
        s.type === "pie"
          ? s.innerRadius && s.innerRadius > 0
            ? "doughnut"
            : "pie"
          : s.type;
      return (
        `Rendered a ${shape} chart${s.title ? ` ("${s.title}")` : ""} — ` +
        `${s.data.length} point(s), ${s.yKeys.length} series (${s.yKeys.join(", ")}). ` +
        `It is displayed in the chat; do not repeat the raw data in text.`
      );
    },
  });
}
