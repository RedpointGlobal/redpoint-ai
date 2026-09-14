"use client";

/**
 * #27897 (P2) — <AgentDashboard>: renders a dashboard (header + KPI tile row +
 * chart panels) from the RESULT of a render_view_dashboard tool call (#27957 Phase
 * 2 — the server assembles + validates the spec, so this renders it directly).
 * Reuses <StatTiles> and <ChartCanvas> as primitives so tiles/panels look identical
 * to their standalone forms.
 *
 * Responsive by CONTAINER, not viewport (deterministic, no fragile breakpoints —
 * mirrors how the single-chart modal reuses ChartCanvas at a bigger size):
 *   - inline (narrow chat column): panels STACK 1-up, full-width + readable;
 *   - expanded (wide modal): panels lay out `columns`-up side-by-side (the
 *     dashboard look).
 * ONE expand button opens the whole dashboard at h-[85vh] w-[95vw].
 */
import { useState } from "react";
import { Maximize2Icon } from "lucide-react";
import type { DashboardSpec } from "@/lib/dashboard-spec";
import type { ChartSpec } from "@/lib/chart-spec";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatTiles } from "@/components/chat/agent-stats";
import { ChartCanvas } from "@/components/chat/agent-chart";
import { AgentToolSkeleton } from "@/components/chat/agent-tool-skeleton";

/**
 * One chart panel: a framed card with its own header + the shared chart canvas.
 * `cols` is the grid's column count so the panel's `colSpan` can be clamped to it
 * (a colSpan-2 panel = a full-width row in a 2-column grid). Inline (cols=1) every
 * panel spans 1 and they stack.
 */
function DashboardPanel({ spec, cols }: { spec: ChartSpec; cols: number }) {
  const span = Math.min(spec.colSpan ?? 1, cols);
  return (
    <div
      style={{ gridColumn: `span ${span}` }}
      className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5 font-dash text-card-foreground shadow-dash"
    >
      {spec.title || spec.subtitle ? (
        <div className="mb-3 min-w-0">
          {spec.title ? (
            <h4 className="truncate text-sm font-semibold tracking-tight text-foreground" title={spec.title}>
              {spec.title}
            </h4>
          ) : null}
          {spec.subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={spec.subtitle}>
              {spec.subtitle}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="h-[320px] w-full">
        <ChartCanvas spec={spec} />
      </div>
    </div>
  );
}

/**
 * The dashboard content (tiles + panel grid), shared by the inline view and the
 * modal. `expanded` picks the panel grid width: 1-up inline, `columns`-up expanded.
 */
export function DashboardBody({ spec, expanded }: { spec: DashboardSpec; expanded: boolean }) {
  const cols = expanded ? Math.min(Math.max(spec.columns ?? 2, 1), 6) : 1;
  return (
    <div className="flex flex-col gap-4">
      {spec.tiles && spec.tiles.length > 0 ? <StatTiles spec={{ tiles: spec.tiles }} /> : null}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {spec.panels.map((panel, i) => (
          <DashboardPanel key={i} spec={panel} cols={cols} />
        ))}
      </div>
    </div>
  );
}

export function AgentDashboard({ spec }: { spec: DashboardSpec }) {
  const [expanded, setExpanded] = useState(false);

  // No malformed-spec guard: the server (render_view_dashboard) re-validates the
  // spec with DashboardSpecSchema before returning it, so an invalid spec never
  // reaches here by construction.
  const title = spec.title?.trim() || "Dashboard";

  return (
    <section className="group relative my-3 w-full font-dash">
      <div className="mb-3 flex items-start justify-between gap-2">
        {spec.title || spec.subtitle ? (
          <div className="min-w-0">
            {spec.title ? (
              <h3 className="truncate text-lg font-semibold tracking-tight text-foreground" title={spec.title}>
                {spec.title}
              </h3>
            ) : null}
            {spec.subtitle ? (
              <p className="mt-0.5 truncate text-sm text-muted-foreground" title={spec.subtitle}>
                {spec.subtitle}
              </p>
            ) : null}
          </div>
        ) : (
          <span />
        )}
        {/* ONE expand control for the whole dashboard — opens the side-by-side grid. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Expand dashboard to fullscreen"
          title="Expand"
          className="shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100"
          onClick={() => setExpanded(true)}
        >
          <Maximize2Icon />
        </Button>
      </div>

      {/* Inline: 1-up stack, readable in the narrow chat column. */}
      <DashboardBody spec={spec} expanded={false} />

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[85vh] w-[80vw] max-w-[80vw] flex-col sm:max-w-[80vw]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {spec.subtitle ? (
              <p className="text-sm text-muted-foreground">{spec.subtitle}</p>
            ) : null}
          </DialogHeader>
          {/* Expanded: columns-up side-by-side grid. Scrolls if it overflows. */}
          {/* Cap the expanded content at a readable width (≈ the reference
              artifact's 1040px), centered — the dialog is 95vw but the cards
              shouldn't stretch to full width. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1040px]">
              <DashboardBody spec={spec} expanded={true} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * assistant-ui tool-UI: maps the render_view_dashboard tool call → <AgentDashboard>.
 * Renders from the tool RESULT (the server-assembled, server-validated DashboardSpec),
 * NOT the args — the args are just { viewId, params }. Mount once inside the runtime
 * provider (see chat-panel.tsx).
 */
export const RenderDashboardToolUI = makeAssistantToolUI<
  { viewId?: string; params?: unknown },
  DashboardSpec
>({
  toolName: "render_view_dashboard",
  // Skeleton until the server returns the assembled spec (a real async fetch +
  // assemble); render the dashboard from the result once present.
  render: ({ result, status }) =>
    status?.type === "complete" && result ? (
      <AgentDashboard spec={result} />
    ) : (
      <AgentToolSkeleton label="Building dashboard…" />
    ),
});
