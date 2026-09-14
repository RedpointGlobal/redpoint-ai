/**
 * #27957 (Phase 2) — the "interaction-run-counts" view: the FIRST deterministic,
 * code-assembled dashboard. Data comes from the RPI 7.8 server-side GROUP BY
 * (mcp-rpi `get_interaction_run_counts`); the layout is assembled PURELY in code
 * (`templateFn`), never composed by the LLM.
 *
 * Product micro (locked): run-counts ALONE — a full-width stacked bar (runs over
 * time, split by execution mode), a test-vs-production donut, and headline tiles.
 * No per-interaction panel (that stays the separate summarize_interaction_runs
 * text path).
 */
import { z } from "zod";
import type { Tool } from "ai";
import type { DashboardSpec } from "@redpoint-ai/shared";
import type { ViewDashboard, ViewContext } from "./registry.js";

// --- Structural shape of the run-counts result (mirrors the mcp-rpi generated
// InteractionRunCountsResultsJsonResponseMessage; kept structural so apps/server
// stays decoupled from mcp-rpi's generated types — the data crosses as JSON). ---
interface ExecModeCount {
  executionMode?: string | null;
  resultsCount?: number | null;
}
interface RunCountBucket {
  date?: string | null;
  executionModes?: ExecModeCount[] | null;
  totalRuns?: number | null;
}
export interface RunCountsData {
  results?: RunCountBucket[] | null;
  executionModes?: ExecModeCount[] | null;
  totalRuns?: number | null;
}

export const runCountsParamsSchema = z
  .object({
    fromDate: z.string().min(1),
    toDate: z.string().min(1),
    granularity: z.enum(["Day", "Week", "Month"]).default("Day"),
    executionMode: z.enum(["All", "Test", "Production"]).default("All"),
  })
  .strict();

export type RunCountsParams = z.infer<typeof runCountsParamsSchema>;

const RUN_COUNTS_TOOL = "rpi__get_interaction_run_counts";

// Stable series order for the stacked bar + donut so the same data → the same
// spec. Known modes first (fixed order), then any others in first-seen order.
const KNOWN_MODE_ORDER = ["Production", "Test"] as const;

function orderedModes(overall: ExecModeCount[]): string[] {
  const present = overall
    .map((m) => (m.executionMode ?? "").trim())
    .filter((m) => m.length > 0);
  const known = KNOWN_MODE_ORDER.filter((m) => present.includes(m));
  const extras = present.filter((m) => !KNOWN_MODE_ORDER.includes(m as never));
  // De-dupe while preserving order.
  return [...new Set([...known, ...extras])];
}

function countFor(modes: ExecModeCount[] | null | undefined, mode: string): number {
  const hit = (modes ?? []).find((m) => (m.executionMode ?? "").trim() === mode);
  return Math.max(0, Math.round(Number(hit?.resultsCount ?? 0)) || 0);
}

/**
 * PURE assembly: (data, params) → DashboardSpec. Deterministic, zero inference,
 * no network, no LLM. Same input → byte-identical spec. Tolerant of a bad/empty/
 * partial response (never throws): missing fields default to 0/empty and it still
 * emits a schema-valid spec.
 */
export function templateFn(data: RunCountsData, params: RunCountsParams): DashboardSpec {
  const buckets = Array.isArray(data?.results) ? data.results : [];
  const overall = Array.isArray(data?.executionModes) ? data.executionModes : [];
  const modes = orderedModes(overall);
  // If the instance returned no overall breakdown, fall back to the known modes so
  // the bar/donut still have stable series (they'll simply read 0).
  const series = modes.length > 0 ? modes : [...KNOWN_MODE_ORDER];

  // Bar rows: one per time bucket, each mode a series (RPI's date-ascending order).
  // The area panel reuses these SAME rows + series (per-day test/prod as bands).
  // Empty → one zero row keyed by fromDate so the panels stay schema-valid (a
  // truthful 0, not invented data).
  const barRows: Record<string, string | number>[] =
    buckets.length > 0
      ? buckets.map((b) => {
          const row: Record<string, string | number> = { date: (b.date ?? "").slice(0, 10) || "—" };
          for (const m of series) row[m] = countFor(b.executionModes, m);
          return row;
        })
      : [
          (() => {
            const row: Record<string, string | number> = { date: params.fromDate.slice(0, 10) };
            for (const m of series) row[m] = 0;
            return row;
          })(),
        ];

  const totalRuns = Math.max(0, Math.round(Number(data?.totalRuns ?? 0)) || 0);
  const daysWithRuns = buckets.filter((b) => (Number(b.totalRuns ?? 0) || 0) > 0).length;
  const production = countFor(overall, "Production");
  const test = countFor(overall, "Test");

  const granLabel =
    params.granularity === "Week" ? "week" : params.granularity === "Month" ? "month" : "day";
  const subtitle =
    `${params.fromDate.slice(0, 10)} → ${params.toDate.slice(0, 10)}` +
    (params.executionMode !== "All" ? ` · ${params.executionMode} only` : "");

  const tiles: DashboardSpec["tiles"] = [
    { value: totalRuns.toLocaleString("en-US"), label: "Total runs" },
    { value: daysWithRuns.toLocaleString("en-US"), label: `${granLabel}s with runs` },
    { value: production.toLocaleString("en-US"), label: "Production runs" },
    { value: test.toLocaleString("en-US"), label: "Test runs" },
  ];

  // Layout = the approved 5-col grid: full-width stacked bar on top, then a 60/40
  // row (area 3-wide + donut 2-wide).
  const panels: DashboardSpec["panels"] = [
    {
      type: "bar",
      stacked: true,
      colSpan: 5,
      orientation: "vertical",
      title: `Runs by ${granLabel}`,
      xKey: "date",
      yKeys: series,
      data: barRows,
      showLegend: series.length > 1,
    },
    {
      type: "area",
      stacked: false, // two distinct test/prod bands, not a running total
      colSpan: 3,
      orientation: "vertical",
      title: "Runs over time",
      xKey: "date",
      yKeys: series, // same test/prod series + rows as the bar
      data: barRows,
      showLegend: series.length > 1,
    },
    {
      type: "pie",
      innerRadius: 55,
      colSpan: 2,
      orientation: "vertical", // ignored for pie; required by the output ChartSpec type
      title: "Test vs production",
      xKey: "mode",
      yKeys: ["count"],
      data: [
        { mode: "Production", count: production },
        { mode: "Test", count: test },
      ],
    },
  ];

  return {
    title: "Interaction runs",
    subtitle,
    tiles,
    panels,
    columns: 5,
  };
}

/**
 * DUMB fetch: call the mcp-rpi run-counts tool AS THE USER (auth + tenant already
 * baked into the authed mcpTools map by the route) and return its structured JSON.
 * No shaping — templateFn owns assembly.
 */
async function dataSource(params: RunCountsParams, ctx: ViewContext): Promise<RunCountsData> {
  const tool = ctx.mcpTools[RUN_COUNTS_TOOL];
  if (!tool?.execute) {
    throw new Error(
      `The run-counts data tool (${RUN_COUNTS_TOOL}) is not available — an RPI connection is required for this view.`,
    );
  }
  const raw = await (tool as Required<Tool>).execute(
    {
      fromDate: params.fromDate,
      toDate: params.toDate,
      granularity: params.granularity,
      executionMode: params.executionMode,
    },
    { toolCallId: `view-${RUN_COUNTS_TOOL}`, messages: [] },
  );
  return parseToolResult(raw);
}

/**
 * MCP tools return an MCP CallToolResult ({ content: [{ type:"text", text }] }).
 * Extract the first text part and JSON-parse it; pass a plain object through as-is.
 * Never throws on shape — a bad payload yields {} and templateFn zero-fills.
 */
export function parseToolResult(raw: unknown): RunCountsData {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const textPart = content.find(
        (p): p is { type: string; text: string } =>
          !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      );
      if (textPart) {
        try {
          return JSON.parse(textPart.text) as RunCountsData;
        } catch {
          return {};
        }
      }
      return {};
    }
    // Already a structured object (not content-wrapped).
    return raw as RunCountsData;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as RunCountsData;
    } catch {
      return {};
    }
  }
  return {};
}

export const interactionRunCountsView: ViewDashboard<RunCountsParams, RunCountsData> = {
  id: "interaction-run-counts",
  description:
    "Interaction RUNS over time — a stacked bar of runs per day/week/month split by " +
    "execution mode, a test-vs-production donut, and headline tiles. Use for a runs " +
    "dashboard/report/overview/trend. params: { fromDate, toDate, granularity?: " +
    "Day|Week|Month, executionMode?: All|Test|Production }.",
  paramsSchema: runCountsParamsSchema,
  dataSource,
  templateFn,
};
