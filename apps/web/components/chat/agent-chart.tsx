"use client";

/**
 * #27897 (Approach B) — <AgentChart>: renders a schema-validated chart spec with
 * Recharts. No model-authored code — the render_chart tool ARGS are the spec, and
 * assistant-ui hands them here via makeAssistantToolUI. One spec renders at any
 * size (ResponsiveContainer).
 *
 * Theming (task 3): series colours come from the categorical --dataviz-* palette
 * (Okabe–Ito, colourblind-safe; see globals.css), referenced as CSS var() so a
 * light/dark switch recolours the SVG with no JS. Axis text, gridlines, tooltip
 * and legend all read the app's semantic tokens (--muted-foreground, --border,
 * --popover, --foreground) so the chart is legible in both themes.
 */
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Label,
} from "recharts";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { AgentToolSkeleton } from "@/components/chat/agent-tool-skeleton";
import { useRef, useState } from "react";
import { Maximize2Icon, DownloadIcon } from "lucide-react";
import { chartLayout, isChartSpec, type ChartSpec } from "@/lib/chart-spec";
import { exportChartAsPng, exportChartAsSvg } from "@/lib/chart-export";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Categorical series colours — the 8 theme-aware --dataviz-* tokens, in order.
// Referenced as var() so the SVG recolours on a light/dark switch with no JS.
// Beyond 8 series it cycles (a known ambiguity — repeated hue): the spec layer
// should cap/aggregate into an "Other" bucket rather than emit a 9th series, but
// cycling is a safe render-time fallback so a large spec still draws.
const PALETTE_SIZE = 8;
const color = (i: number) => `var(--dataviz-${(i % PALETTE_SIZE) + 1})`;

// Shared chart chrome (#27897 followup — the "gorgeous target" visual language).
// Every chart type below consumes THESE — axis, grid, tooltip, legend — so bar,
// line, area, pie AND scatter all inherit the same polish and theme-awareness.
// IBM Plex Mono carries the figures/ticks; --dash-* + semantic tokens keep it
// legible in light and dark.
const MONO = "var(--font-plex-mono), ui-monospace, monospace";
const SANS = "var(--font-plex-sans), system-ui, sans-serif";
const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 11, fontFamily: MONO };
const AXIS_LINE = { stroke: "var(--border)" };
// Soft, layered card-style tooltip (mono figures) — matches the tile/panel lift.
const TOOLTIP_CONTENT = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  boxShadow: "var(--dash-card-shadow)",
  fontFamily: MONO,
  fontSize: 12,
  padding: "8px 10px",
  color: "var(--foreground)",
};
const LEGEND_STYLE = { color: "var(--muted-foreground)", fontSize: 12, fontFamily: SANS };

/**
 * The Recharts canvas itself (chart + ResponsiveContainer), sized by its parent.
 * Shared by the inline figure and the fullscreen modal so both render identically
 * at whatever height the container gives them.
 */
export function ChartCanvas({ spec }: { spec: ChartSpec }) {
  const l = chartLayout(spec);
  return (
    <ResponsiveContainer width="100%" height="100%">
      {renderChart(spec, l)}
    </ResponsiveContainer>
  );
}

export function AgentChart({ spec }: { spec: ChartSpec }) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The modal's chart wrapper — export reads the live <svg> Recharts renders here
  // (the larger modal render exports at higher resolution than the inline one).
  const modalRef = useRef<HTMLDivElement>(null);

  if (!isChartSpec(spec)) {
    return (
      <div className="my-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Chart could not be rendered — the chart spec was malformed.
      </div>
    );
  }

  const title = spec.title?.trim() || "Chart";

  async function handleExport(format: "png" | "svg") {
    const svg = modalRef.current?.querySelector("svg");
    if (!svg) return;
    setExporting(true);
    try {
      if (format === "svg") exportChartAsSvg(svg as SVGSVGElement, title);
      else await exportChartAsPng(svg as SVGSVGElement, title);
    } catch (err) {
      console.error("[chart] export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    // Framed card (P2): rounded border + card surface + padding + light shadow,
    // all via semantic tokens so it themes light/dark. This is the dashboard
    // building block — a chart reads as a self-contained card in the chat.
    <figure className="group relative my-3 w-full rounded-2xl border border-border bg-card p-5 font-dash text-card-foreground shadow-dash">
      <div className="mb-3 flex items-start justify-between gap-2">
        {spec.title || spec.subtitle ? (
          <figcaption className="min-w-0">
            {spec.title ? (
              <h3 className="truncate text-base font-semibold tracking-tight text-foreground" title={spec.title}>
                {spec.title}
              </h3>
            ) : null}
            {spec.subtitle ? (
              <p className="mt-0.5 truncate text-sm text-muted-foreground" title={spec.subtitle}>
                {spec.subtitle}
              </p>
            ) : null}
          </figcaption>
        ) : (
          <span />
        )}
        {/* Expand-to-fullscreen (task 4). Ghost by default, clearer on hover; the
            modal reuses the exact same ChartCanvas at a much larger size. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Expand chart to fullscreen"
          title="Expand"
          className="shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100"
          onClick={() => setExpanded(true)}
        >
          <Maximize2Icon />
        </Button>
      </div>
      <div className="h-[320px] w-full">
        <ChartCanvas spec={spec} />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[85vh] w-[95vw] max-w-[95vw] flex-col sm:max-w-[95vw]">
          <DialogHeader className="flex-row items-start justify-between gap-2 pr-10">
            <div className="min-w-0">
              <DialogTitle>{title}</DialogTitle>
              {spec.subtitle ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{spec.subtitle}</p>
              ) : null}
            </div>
            {/* Export (task 5). Both formats inline the computed theme colours so
                the file is colour-correct standalone (see chart-export.ts). */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={exporting}
                onClick={() => handleExport("png")}
              >
                <DownloadIcon />
                PNG
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={exporting}
                onClick={() => handleExport("svg")}
              >
                <DownloadIcon />
                SVG
              </Button>
            </div>
          </DialogHeader>
          <div ref={modalRef} className="min-h-0 flex-1">
            <ChartCanvas spec={spec} />
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
}

function renderChart(spec: ChartSpec, l: ReturnType<typeof chartLayout>) {
  // Shared, theme-aware chrome so every chart type is legible in light + dark.
  // Faint horizontal-only rules (the target look) — a solid hairline in --dash-grid,
  // no vertical clutter. Scatter re-enables verticals (it needs both axes gridded).
  const grid = l.showGrid ? (
    <CartesianGrid vertical={l.kind === "scatter"} stroke="var(--dash-grid)" strokeWidth={1} />
  ) : undefined;
  const legend = l.showLegend ? <Legend wrapperStyle={LEGEND_STYLE} /> : undefined;
  const tooltip = (
    <Tooltip
      contentStyle={TOOLTIP_CONTENT}
      labelStyle={{ color: "var(--foreground)" }}
      itemStyle={{ color: "var(--foreground)" }}
      cursor={{ fill: "var(--muted-foreground)", fillOpacity: 0.1 }}
    />
  );

  switch (l.kind) {
    case "bar":
      // Horizontal bar = Recharts layout="vertical" with the axes swapped: value
      // on X (number), category on Y (dataKey=xKey). Axis labels follow the data
      // meaning (xAxisLabel = the category axis, yAxisLabel = the value axis)
      // regardless of orientation. Good for ranking / long category labels.
      return l.isHorizontal ? (
        <BarChart data={spec.data} layout="vertical">
          {grid}
          <XAxis type="number" label={axisLabel(spec.yAxisLabel, "bottom")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <YAxis type="category" dataKey={l.xKey} label={axisLabel(spec.xAxisLabel, "left")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={120} />
          {tooltip}
          {legend}
          {l.series.map((k, i) => (
            <Bar key={k} dataKey={k} stackId={l.stacked ? "s" : undefined} fill={color(i)} radius={l.stacked ? 0 : [0, 4, 4, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      ) : (
        <BarChart data={spec.data}>
          {grid}
          <XAxis dataKey={l.xKey} label={axisLabel(spec.xAxisLabel, "bottom")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <YAxis label={axisLabel(spec.yAxisLabel, "left")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          {tooltip}
          {legend}
          {l.series.map((k, i) => (
            <Bar key={k} dataKey={k} stackId={l.stacked ? "s" : undefined} fill={color(i)} radius={l.stacked ? 0 : [4, 4, 0, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      );
    case "line":
      return (
        <LineChart data={spec.data}>
          {grid}
          <XAxis dataKey={l.xKey} label={axisLabel(spec.xAxisLabel, "bottom")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <YAxis label={axisLabel(spec.yAxisLabel, "left")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          {tooltip}
          {legend}
          {l.series.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={color(i)} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} isAnimationActive={false} />
          ))}
        </LineChart>
      );
    case "area":
      return (
        <AreaChart data={spec.data}>
          {grid}
          <XAxis dataKey={l.xKey} label={axisLabel(spec.xAxisLabel, "bottom")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <YAxis label={axisLabel(spec.yAxisLabel, "left")} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          {tooltip}
          {legend}
          {l.series.map((k, i) => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              stackId={l.stacked ? "s" : undefined}
              stroke={color(i)}
              strokeWidth={2}
              fill={color(i)}
              fillOpacity={0.18}
              activeDot={{ r: 4, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      );
    case "pie": {
      // Doughnut only: sum the slice values for the center total (the target look).
      const total = l.isDoughnut
        ? spec.data.reduce((sum, row) => {
            const v = row[l.series[0]];
            return sum + (typeof v === "number" ? v : 0);
          }, 0)
        : 0;
      return (
        <PieChart>
          {tooltip}
          {legend}
          <Pie
            data={spec.data}
            dataKey={l.series[0]}
            nameKey={l.xKey}
            innerRadius={l.isDoughnut ? `${l.innerRadiusPct}%` : 0}
            outerRadius="80%"
            paddingAngle={0}
            isAnimationActive={false}
          >
            {spec.data.map((_, i) => (
              <Cell key={i} fill={color(i)} stroke="none" />
            ))}
            {l.isDoughnut ? <Label content={renderCenterTotal(total, l.series[0]) as never} /> : null}
          </Pie>
        </PieChart>
      );
    }
    case "scatter":
      return (
        <ScatterChart>
          {grid}
          <XAxis type="number" dataKey={l.xKey} name={spec.xAxisLabel ?? l.xKey} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <YAxis type="number" dataKey={l.series[0]} name={spec.yAxisLabel ?? l.series[0]} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <Tooltip
            contentStyle={TOOLTIP_CONTENT}
            labelStyle={{ color: "var(--foreground)" }}
            itemStyle={{ color: "var(--foreground)" }}
            cursor={{ strokeDasharray: "3 3", stroke: "var(--border)" }}
          />
          {legend}
          {l.series.map((k, i) => (
            <Scatter key={k} name={k} data={spec.data} dataKey={k} fill={color(i)} isAnimationActive={false} />
          ))}
        </ScatterChart>
      );
  }
}

/**
 * Center label for a doughnut: the summed total in IBM Plex Mono over a muted
 * caption (the series name). Rendered as SVG <text> so it themes via tokens and
 * exports cleanly with the chart.
 */
function renderCenterTotal(total: number, caption: string) {
  const CenterTotal = (props: { viewBox?: { cx?: number; cy?: number } }) => {
    const cx = props.viewBox?.cx ?? 0;
    const cy = props.viewBox?.cy ?? 0;
    return (
      <g style={{ pointerEvents: "none" }}>
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontFamily: MONO, fontSize: 22, fontWeight: 600, fill: "var(--foreground)" }}
        >
          {total.toLocaleString()}
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontFamily: MONO, fontSize: 10, fill: "var(--muted-foreground)" }}
        >
          {caption}
        </text>
      </g>
    );
  };
  return CenterTotal;
}

function axisLabel(text: string | undefined, position: "bottom" | "left") {
  if (!text) return undefined;
  return position === "left"
    ? { value: text, angle: -90, position: "insideLeft" as const }
    : { value: text, position: "insideBottom" as const, offset: -4 };
}

/**
 * assistant-ui tool-UI: maps the render_chart tool call → <AgentChart>, rendering
 * the tool ARGS (the spec) inline in the chat. Mount once inside the runtime
 * provider (see chat-panel.tsx).
 */
export const RenderChartToolUI = makeAssistantToolUI<ChartSpec, unknown>({
  toolName: "render_chart",
  // Gate on the tool-call status: while args are still STREAMING (not "complete")
  // show a skeleton, not the malformed fallback — the guard only means "bad spec"
  // once the args are fully in.
  render: ({ args, status }) =>
    status?.type === "complete" ? <AgentChart spec={args} /> : <AgentToolSkeleton label="Building chart…" />,
});
