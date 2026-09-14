"use client";

/**
 * #27897 (P2) — <StatTiles>: renders a schema-validated stat-tile spec as a
 * responsive row of KPI cards. Companion to <AgentChart>; the render_stats tool
 * ARGS are the spec, handed here via makeAssistantToolUI. A dashboard building
 * block — a stat-tile row + one or more chart cards compose a dashboard-like view
 * in the chat. Themed entirely via semantic tokens (light/dark, no JS).
 */
import { makeAssistantToolUI } from "@assistant-ui/react";
import { isStatsSpec, type StatsSpec } from "@/lib/stats-spec";
import { AgentToolSkeleton } from "@/components/chat/agent-tool-skeleton";

export function StatTiles({ spec }: { spec: StatsSpec }) {
  if (!isStatsSpec(spec)) {
    return (
      <div className="my-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Stat tiles could not be rendered — the spec was malformed.
      </div>
    );
  }

  return (
    <div className="my-3 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3.5 font-dash">
      {spec.tiles.map((tile, i) => (
        <div
          key={i}
          className="flex flex-col rounded-2xl border border-border bg-card p-[18px] text-card-foreground shadow-dash"
        >
          <span
            className="truncate font-dash-mono text-[30px] font-semibold leading-none tabular-nums tracking-tight"
            style={{ color: tileValueColor(tile.label) }}
            title={tile.value}
          >
            {tile.value}
          </span>
          <span
            className="mt-1.5 truncate text-[12.5px] text-muted-foreground"
            title={tile.label}
          >
            {tile.label}
          </span>
          {tile.sub ? <SubChips sub={tile.sub} /> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Tint a KPI value by what it measures: production → indigo, test/sandbox → amber
 * (the dashboard series colours), everything else the neutral foreground. Keeps
 * the headline figures reading as the same language as the charts below them.
 */
function tileValueColor(label: string): string {
  const l = label.toLowerCase();
  if (/\btest\b|sandbox/.test(l)) return "var(--dash-test)";
  if (/\bprod\b|production/.test(l)) return "var(--dash-prod)";
  return "var(--foreground)";
}

/**
 * The tile's `sub` as pill chip(s). A "·"-separated sub (e.g. "332 test · 53 prod")
 * splits into one chip per part; anything else renders as a single chip. Neutral
 * surface — colour stays in the data, per the dataviz restraint.
 */
function SubChips({ sub }: { sub: string }) {
  const parts = sub.split("·").map((p) => p.trim()).filter(Boolean);
  const chips = parts.length > 0 ? parts : [sub];
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {chips.map((part, i) => (
        <span
          key={i}
          className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          title={part}
        >
          {part}
        </span>
      ))}
    </div>
  );
}

/**
 * assistant-ui tool-UI: maps the render_stats tool call → <StatTiles>, rendering
 * the tool ARGS (the spec) inline in the chat. Mount once inside the runtime
 * provider (see chat-panel.tsx).
 */
export const RenderStatsToolUI = makeAssistantToolUI<StatsSpec, unknown>({
  toolName: "render_stats",
  // Skeleton while args stream; malformed fallback only once complete (see guard).
  render: ({ args, status }) =>
    status?.type === "complete" ? <StatTiles spec={args} /> : <AgentToolSkeleton label="Building stats…" />,
});
