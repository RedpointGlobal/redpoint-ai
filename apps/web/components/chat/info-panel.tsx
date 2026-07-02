"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Download, Trash2, X } from 'lucide-react';
import { DevToolsHooks } from '@assistant-ui/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/lib/version';
import {
  getWorkspace,
  getWorkspaceRuntimeStatus,
  getWorkspaceTools,
  type RuntimeStatus,
  type TelemetryEvent,
  type Workspace,
  type WorkspaceTool,
} from '@/lib/api';

// EventLog isn't re-exported from @assistant-ui/react's public surface; mirror
// the shape here. Drift risk is minimal — three fields, public devtools contract.
interface EventLog {
  time: Date;
  event: string;
  data: unknown;
}

type Tab = "config" | "tools" | "traffic";

interface InfoPanelProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}

interface ParsedConfig {
  provider: { type: string; model: string; baseUrl?: string; azureDeployment?: string };
  agent?: { systemPrompt?: string; maxSteps?: number };
  skills?: string[];
  mcp?: Array<{ name: string; transport: string; url?: string; command?: string }>;
}

// ---------------------------------------------------------------------------
// Panel root
// ---------------------------------------------------------------------------

const TABS: readonly Tab[] = ["config", "tools", "traffic"];
const isTab = (v: string | null): v is Tab =>
  v === "config" || v === "tools" || v === "traffic";

export function InfoPanel({ workspaceId, open, onClose }: InfoPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "traffic";
  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    config: null,
    tools: null,
    traffic: null,
  });
  // The actual scroll container for all three tabpanels. Passed to TrafficTab
  // so its auto-scroll guard measures the element that really scrolls, rather
  // than walking a fixed number of parentElement hops (which breaks whenever
  // wrapper markup like the tabpanel divs changes).
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Roving-tabindex + arrow-key nav for the tablist (WAI-ARIA tabs pattern).
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const idx = TABS.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === "ArrowRight") next = TABS[(idx + 1) % TABS.length];
    else if (e.key === "ArrowLeft") next = TABS[(idx - 1 + TABS.length) % TABS.length];
    else if (e.key === "Home") next = TABS[0];
    else if (e.key === "End") next = TABS[TABS.length - 1];
    if (next) {
      e.preventDefault();
      setTab(next);
      tabRefs.current[next]?.focus();
    }
  };

  // Per-user RPI auth is now attached server-side by the apps/web proxy
  // (`getWorkspaceRuntimeStatus` in lib/api.ts hits `/api/proxy/runtime-status`).
  // This component used to pull `session.rpi.accessToken` and pass it as a
  // header itself; that path is gone now to keep the RPI access_token off the
  // JS layer. The proxy reads the HttpOnly session cookie and forwards the
  // Bearer to apps/server transparently.

  // Fetch workspace config + tools + runtime-status when the panel opens (or
  // workspaceId changes). All three fetches are independent — render whichever
  // resolves first; tabs handle their own loading/error states.
  const [config, setConfig] = useState<ParsedConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [tools, setTools] = useState<WorkspaceTool[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setConfigError(null);
    getWorkspace(workspaceId)
      .then((ws: Workspace) => {
        if (cancelled) return;
        try {
          setConfig(JSON.parse(ws.config) as ParsedConfig);
        } catch (e) {
          setConfigError(`Invalid config JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setConfigError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setTools(null);
    setToolsError(null);
    getWorkspaceTools(workspaceId)
      .then((t) => {
        if (!cancelled) setTools(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setToolsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setRuntime(null);
    setRuntimeError(null);
    // Auth state isn't a dependency anymore — the proxy attaches the Bearer
    // server-side from the cookie, which is sent automatically. Login/logout
    // does cause a full page reload (lib/auth.ts session callback flow), so
    // this effect re-runs naturally on auth state changes.
    getWorkspaceRuntimeStatus(workspaceId)
      .then((r) => {
        if (!cancelled) setRuntime(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setRuntimeError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return (
    /* Outer wrapper handles open/close animation.
         ≥800px: collapses width (w-80 ↔ w-0) so chat reflows alongside.
         <800px: stays full width, slides via translate-x as an overlay drawer.
       The inner div keeps a fixed w-80 so child layout doesn't reflow mid-animation. */
    <div
      className={cn(
        "shrink-0 overflow-hidden motion-safe:transition-[width,translate] motion-safe:duration-300 motion-safe:ease-in-out",
        open ? "w-80" : "w-0",
        "max-[799px]:absolute max-[799px]:inset-y-0 max-[799px]:right-0 max-[799px]:z-30 max-[799px]:w-80!",
        open ? "max-[799px]:translate-x-0" : "max-[799px]:translate-x-full",
      )}
      aria-hidden={!open}
      inert={!open}
    >
    <div className="flex h-full w-80 flex-col border-l border-border bg-background max-[799px]:shadow-2xl">
      {/* Tab bar + close */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <div role="tablist" aria-label="Workspace info" className="flex gap-0.5">
          {TABS.map((t) => {
            const selected = tab === t;
            return (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                role="tab"
                id={`info-tab-${t}`}
                aria-selected={selected}
                aria-controls={`info-tabpanel-${t}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={onTabKeyDown}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium capitalize",
                  "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                  "motion-safe:transition-colors",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close info panel"
        >
          <X />
        </Button>
      </div>

      {/* Scrollable content. One tabpanel per tab; hidden when not active so
          AT users see exactly one labeled region tied to the selected tab. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          role="tabpanel"
          id="info-tabpanel-config"
          aria-labelledby="info-tab-config"
          hidden={tab !== "config"}
        >
          {tab === "config" && (
            <ConfigTab
              config={config}
              error={configError}
              runtime={runtime}
              runtimeError={runtimeError}
            />
          )}
        </div>
        <div
          role="tabpanel"
          id="info-tabpanel-tools"
          aria-labelledby="info-tab-tools"
          hidden={tab !== "tools"}
        >
          {tab === "tools" && <ToolsTab tools={tools} error={toolsError} />}
        </div>
        <div
          role="tabpanel"
          id="info-tabpanel-traffic"
          aria-labelledby="info-tab-traffic"
          hidden={tab !== "traffic"}
        >
          {tab === "traffic" && (
            <TrafficTab
              workspaceId={workspaceId}
              model={config?.provider.model}
              mcpUrl={runtime?.mcp?.[0]?.url}
              scrollContainerRef={scrollRef}
            />
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config tab
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<RuntimeStatus["tier"], { label: string; tone: string; hint: string }> = {
  "skill-router":       { label: "Skill router",       tone: "bg-green-500/10 text-green-600 dark:text-green-400", hint: "ONE meta-tool exposed (execute_skill); LLM picks a skill; sub-agent runs with that skill's tools." },
  "category-discovery": { label: "Category discovery", tone: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400", hint: "ONE meta-tool exposed (tools_list); LLM browses MCP categories on demand." },
  "flat":               { label: "Flat",                tone: "bg-orange-500/10 text-orange-700 dark:text-orange-400", hint: "All discovered MCP tools exposed at once. Worst-case fallback." },
};

function ConfigTab({
  config,
  error,
  runtime,
  runtimeError,
}: {
  config: ParsedConfig | null;
  error: string | null;
  runtime: RuntimeStatus | null;
  runtimeError: string | null;
}) {
  if (error) return <Status kind="error">{error}</Status>;
  if (!config) return <Status kind="loading">Loading config…</Status>;

  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      {/* Runtime errors surfaced first — same style as terminal's "Warning: ..." prefix */}
      {runtime?.errors?.length ? (
        <Section title={`Warnings (${runtime.errors.length})`}>
          <ul className="flex flex-col gap-1">
            {runtime.errors.map((e, i) => (
              <li key={i} className="rounded bg-destructive/10 px-2 py-1 text-destructive">
                {e}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* Active tier — terminal-parity diagnostic, color-coded by quality */}
      <Section title="Active tier">
        {runtimeError ? (
          <span className="text-destructive">{runtimeError}</span>
        ) : !runtime ? (
          <span className="text-muted-foreground">Resolving…</span>
        ) : (
          <div className="flex flex-col gap-1">
            <span
              className={cn(
                "self-start rounded px-1.5 py-0.5 text-[10px] font-medium",
                TIER_LABELS[runtime.tier].tone,
              )}
            >
              {TIER_LABELS[runtime.tier].label}
            </span>
            <span className="text-muted-foreground">{TIER_LABELS[runtime.tier].hint}</span>
          </div>
        )}
      </Section>

      <Section title="Build">
        <Row label="Version" value={APP_VERSION} />
      </Section>

      <Section title="Provider">
        <Row label="Type"     value={config.provider.type} />
        <Row label="Model"    value={config.provider.model} />
        {config.provider.azureDeployment && (
          <Row label="Deployment" value={config.provider.azureDeployment} />
        )}
        {config.provider.baseUrl && <Row label="Base URL" value={config.provider.baseUrl} breakAll />}
      </Section>

      {runtime?.providers?.length ? (
        <Section title="Provider availability">
          <ul className="flex flex-col gap-0.5">
            {runtime.providers.map((p) => (
              <li key={p.type} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      p.configured ? "bg-green-500" : "bg-muted-foreground/40",
                    )}
                  />
                  <span>{p.name}</span>
                </span>
                {p.configured ? (
                  <span className="text-green-600 dark:text-green-400">configured</span>
                ) : (
                  <span className="font-mono text-muted-foreground">
                    {p.missingEnvVar ?? "unset"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Agent">
        <Row label="Max steps" value={String(config.agent?.maxSteps ?? 20)} />
      </Section>

      <Section title={`Skills (${runtime?.skills.loaded ?? config.skills?.length ?? 0})`}>
        {runtime?.skills.details?.length ? (
          <div className="flex flex-col gap-0.5">
            {runtime.skills.details.map((s) => (
              <div key={s.name} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium",
                      s.type === "expert"
                        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : s.type === "hybrid"
                          ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                          : "bg-orange-500/10 text-orange-600 dark:text-orange-400",
                    )}
                  >
                    {s.type}
                  </span>
                  <span className="truncate font-mono" title={s.name}>
                    {s.name}
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {s.type === "expert" ? "—" : `${s.toolCount} tools`}
                </span>
              </div>
            ))}
          </div>
        ) : config.skills?.length ? (
          <div className="flex flex-wrap gap-1">
            {config.skills.map((s) => (
              <span key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {s}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">None configured</span>
        )}
      </Section>

      <Section title={`MCP Connections (${runtime?.mcp.length ?? config.mcp?.length ?? 0})`}>
        {runtime?.mcp?.length ? (
          runtime.mcp.map((m) => (
            <div key={m.name} className="flex flex-col gap-0.5 rounded-md border border-border p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono font-medium" title={m.name}>
                  {m.name}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    m.connected
                      ? "bg-green-500/10 text-green-600 dark:text-green-400"
                      : "bg-destructive/10 text-destructive",
                  )}
                >
                  {m.connected ? "connected" : "unreachable"}
                </span>
              </div>
              {m.url && <Row label="URL" value={m.url} breakAll />}
              <Row label="Transport" value={m.transport} />
              {m.connected && (
                <>
                  <Row label="Tools" value={String(m.toolCount)} />
                  <Row label="Filtering" value={m.supportsFiltering ? "supported" : "no"} />
                  {m.categories.length > 0 && (
                    <Row label="Categories" value={m.categories.join(", ")} />
                  )}
                </>
              )}
              <Row
                label="Auth"
                value={
                  m.auth === "authenticated"
                    ? "authenticated"
                    : m.auth === "failed"
                      ? "failed (401)"
                      : "none required"
                }
              />
              {m.error && (
                <pre className="mt-1 rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive whitespace-pre-wrap">
                  {m.error}
                </pre>
              )}
            </div>
          ))
        ) : config.mcp?.length ? (
          config.mcp.map((m) => (
            <div key={m.name} className="flex flex-col gap-0.5 rounded-md border border-border p-2">
              <Row label="Name"      value={m.name} />
              {m.url && <Row label="URL" value={m.url} breakAll />}
              {m.command && <Row label="Command" value={m.command} breakAll />}
              <Row label="Transport" value={m.transport} />
            </div>
          ))
        ) : (
          <span className="text-muted-foreground">None configured</span>
        )}
      </Section>

    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools tab
// ---------------------------------------------------------------------------

function ToolsTab({ tools, error }: { tools: WorkspaceTool[] | null; error: string | null }) {
  if (error) return <Status kind="error">{error}</Status>;
  if (!tools) return <Status kind="loading">Loading tools…</Status>;

  return (
    <div className="flex flex-col gap-1.5 p-3">
      <p className="mb-1 text-xs text-muted-foreground">
        {tools.length} tool{tools.length === 1 ? "" : "s"} discovered for this workspace
      </p>
      {tools.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No MCP connections configured, or the connected server is not exposing any tools.
        </p>
      ) : (
        tools.map((tool) => <ToolCard key={tool.name} tool={tool} />)
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: WorkspaceTool }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      title={expanded ? "Collapse" : "Expand"}
      className={cn(
        "block w-full cursor-pointer rounded-md border border-border p-2 text-left text-xs",
        "touch-manipulation [-webkit-tap-highlight-color:transparent]",
        "hover:bg-muted/40",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <h3 className="block truncate font-mono text-xs font-medium" title={tool.name}>
        {tool.name}
      </h3>
      <p
        className={cn(
          "mt-0.5 text-muted-foreground",
          !expanded && "line-clamp-3",
        )}
      >
        {tool.description}
      </p>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Traffic tab
// ---------------------------------------------------------------------------

// Direction-tagged labels — terminal Ink parity (TrafficPanel.tsx:26–41).
// The server makes directions real signal (it instruments BOTH sides
// of the agent boundary), so the labels are honest, not synthetic.
// Errors get a red override regardless of direction.
const DIRECTION_LABEL: Record<TelemetryEvent["direction"], string> = {
  ToLLM:   "→LLM",
  FromLLM: "←LLM",
  ToMCP:   "→MCP",
  FromMCP: "←MCP",
  System:  " ● ",
};
const DIRECTION_STYLE: Record<TelemetryEvent["direction"], string> = {
  ToLLM:   "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  FromLLM: "bg-green-500/10 text-green-600 dark:text-green-400",
  ToMCP:   "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  FromMCP: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  System:  "bg-muted text-muted-foreground",
};
const ERROR_STYLE = "bg-destructive/10 text-destructive";

// Convert a DevToolsHooks EventLog (thread-lifecycle: thread.runStart,
// composer.send, etc.) into a TelemetryEvent so the live panel can merge
// it alongside server-emitted rich events (tool-call, tool-result, etc.)
// in a single uniformly-typed list. The lifecycle events are direction=System
// since they carry no LLM/MCP traffic — they're framing for the run.
//
// Tagged source: "lifecycle" so the panel can hide them (run-start/end is
// visual noise — the user already sees the run in the chat itself); export
// keeps them so triage can correlate run boundaries with telemetry.
function lifecycleToTelemetry(e: EventLog): TelemetryEvent {
  return {
    timestamp: e.time.toISOString(),
    direction: "System",
    type: "generation-finish", // closest type slot for lifecycle framing
    message: `● ${e.event}${
      e.data && typeof e.data === "object"
        ? ` ${JSON.stringify(e.data).slice(0, 60)}`
        : ""
    }`,
    source: "lifecycle",
  };
}

// Reset on every real document load (module re-evaluates), but survives
// in-session React remounts (e.g. toggling the info panel closed/open). Used to
// wipe the persisted server-side trace buffer exactly once per page refresh.
let traceClearedForThisPageLoad = false;

// Locale-aware HH:mm:ss.SSS formatter. Forced to 24-hour so the terminal-parity
// row layout doesn't shift width when an AM/PM token appears in 12-hour locales.
// Lazy-initialized so module evaluation on the server doesn't capture a locale
// that might differ from the client's at hydration time.
let timeFormatter: Intl.DateTimeFormat | null = null;
function getTimeFormatter(): Intl.DateTimeFormat {
  if (!timeFormatter) {
    timeFormatter = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    });
  }
  return timeFormatter;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(11, 23) : getTimeFormatter().format(d);
}

function TrafficTab({
  workspaceId,
  model,
  mcpUrl,
  scrollContainerRef,
}: {
  workspaceId: string;
  model?: string;
  mcpUrl?: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Unified entries list — both DevToolsHooks lifecycle and server-side
  // TelemetryEvents end up here in the same shape. The server captured the
  // rich trace server-side but the live panel only saw lifecycle; this
  // closes that gap (RPI terminal agent's review).
  const [entries, setEntries] = useState<TelemetryEvent[]>([]);
  const seenKeys = useRef(new Set<string>());
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Append helper that dedupes on (timestamp + type + message). The server
  // SSE replays the existing trace buffer on connect, so without a dedupe
  // a Tab close→reopen would double-render historic events. Using a ref'd
  // Set avoids per-event closure churn.
  const append = (ev: TelemetryEvent) => {
    const key = `${ev.timestamp}|${ev.type}|${ev.message}`;
    if (seenKeys.current.has(key)) return;
    seenKeys.current.add(key);
    setEntries((prev) => {
      const next = [...prev, ev];
      next.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return next;
    });
  };

  // DevToolsHooks (lifecycle layer). On every notification, re-read the
  // browser-side log buffer, convert any new entries to TelemetryEvents,
  // and append.
  useEffect(() => {
    const refresh = () => {
      for (const { logs } of DevToolsHooks.getApis().values()) {
        for (const log of logs) append(lifecycleToTelemetry(log));
      }
    };
    refresh();
    return DevToolsHooks.subscribe(refresh);
  }, []);

  // Server-side trace SSE stream (rich layer). Open an EventSource, parse
  // each event into a TelemetryEvent, append. The endpoint replays the
  // existing buffer on connect so a late mount picks up prior events; the
  // dedupe in append() handles overlaps with lifecycle events.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
    let es: EventSource | null = null;
    let closed = false;

    const subscribe = () => {
      if (closed) return;
      es = new EventSource(
        `${apiUrl}/api/v1/workspaces/${workspaceId}/trace/stream`,
      );
      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data) as TelemetryEvent;
          // Tag server-side TelemetryEvents as "telemetry" — these are the
          // meaningful steps shown in the panel. (Lifecycle events come
          // from DevToolsHooks via lifecycleToTelemetry, already tagged.)
          append({ ...ev, source: ev.source ?? "telemetry" });
        } catch {
          /* malformed — ignore */
        }
      };
      es.onerror = () => {
        // Browser will auto-reconnect; nothing to do here. Logging would just
        // spam the console during transient network blips.
      };
    };

    // On a real page load (refresh), wipe the persisted server-side trace
    // buffer ONCE before subscribing — otherwise the stream replays the
    // previous page-session's events and the panel looks like it never
    // emptied. The module flag survives in-session panel toggles, so
    // closing/reopening the panel keeps the current session's trace.
    if (!traceClearedForThisPageLoad) {
      traceClearedForThisPageLoad = true;
      fetch(`${apiUrl}/api/v1/workspaces/${workspaceId}/trace?clear=1`)
        .catch(() => {})
        .finally(subscribe);
    } else {
      subscribe();
    }

    return () => {
      closed = true;
      es?.close();
    };
  }, [workspaceId]);

  // Panel renders only telemetry events (the meaningful steps). Lifecycle
  // events (thread.runStart, composer.send, etc.) are visual noise — the
  // user already sees runs starting/ending in the chat itself. They stay
  // in `entries` so the Export button still includes them for triage.
  const visibleEntries = useMemo(
    () => entries.filter((e) => e.source !== "lifecycle"),
    [entries],
  );

  // Auto-scroll to the latest event when the user is already near the bottom.
  // If they've scrolled up to read history, don't yank them back. Threshold
  // (48px) is generous enough to catch "basically at the bottom" without
  // requiring pixel-perfect positioning. Reduced-motion users get an instant
  // jump instead of smooth scroll.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const scroller = scrollContainerRef.current;
    const nearBottom =
      !scroller ||
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 48;
    if (!nearBottom) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "end",
    });
  }, [visibleEntries.length, scrollContainerRef]);

  const clear = () => {
    for (const [id] of DevToolsHooks.getApis()) DevToolsHooks.clearEventLogs(id);
    seenKeys.current.clear();
    setEntries([]);
    // Best-effort server-side clear too; ignored if it fails.
    fetch(
      `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000"}/api/v1/workspaces/${workspaceId}/trace?clear=1`,
    ).catch(() => {});
  };

  // Export — entries are already TelemetryEvents, so the JSON envelope is
  // a direct dump. Output shape stays drop-in interchangeable with the
  // terminal agent's /export.
  const exportJson = () => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `rp-agent-traffic-${ts}.json`;
    const payload = {
      exportedAt: new Date().toISOString(),
      workspaceId,
      model: model ?? "(unknown)",
      server: mcpUrl ?? "(unknown)",
      eventCount: entries.length,
      events: entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {visibleEntries.length} event{visibleEntries.length === 1 ? "" : "s"}
          {entries.length > visibleEntries.length && (
            <span className="ml-1 opacity-60">
              (+{entries.length - visibleEntries.length} lifecycle in export)
            </span>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={exportJson}
            aria-label="Export traffic to JSON"
            disabled={entries.length === 0}
          >
            <Download />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={clear}
            aria-label="Clear traffic log"
            disabled={entries.length === 0}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <div
        role="log"
        aria-live="polite"
        aria-label="Runtime traffic events"
        className="flex flex-col divide-y divide-border"
      >
        {visibleEntries.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-muted-foreground">
            No events yet. Send a message in the chat to see live runtime traffic.
          </p>
        ) : (
          // Terminal-parity row: HH:mm:ss.SSS [direction-tag] message.
          // No inline JSON — that's forensic data, lives only in the export.
          // Lifecycle events (thread.runStart, composer.send, etc.) are
          // filtered out via visibleEntries — they're framing the user
          // already sees in the chat itself; visible only in the export.
          // Key on the same (timestamp+type+message) tuple append() dedupes
          // on — stable across the sorted re-insert so each row's local
          // expanded state stays bound to its own event.
          visibleEntries.map((entry) => (
            <TrafficRow
              key={`${entry.timestamp}|${entry.type}|${entry.message}`}
              entry={entry}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// Single traffic row. Local expanded state lets the user toggle between the
// terminal-parity truncated layout and a wrapped full-message view by clicking
// (or pressing Enter/Space) on the row.
function TrafficRow({ entry }: { entry: TelemetryEvent }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className={cn(
        "flex w-full items-baseline gap-1.5 px-3 py-1 text-left text-[11px]",
        "cursor-pointer hover:bg-muted/40",
        "touch-manipulation [-webkit-tap-highlight-color:transparent]",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        "[content-visibility:auto] [contain-intrinsic-size:auto_24px]",
      )}
    >
      <span className="shrink-0 font-mono text-muted-foreground">
        {formatTime(entry.timestamp)}
      </span>
      <span
        className={cn(
          "shrink-0 rounded px-1 py-0.5 font-mono text-[10px] font-medium",
          entry.error ? ERROR_STYLE : DIRECTION_STYLE[entry.direction],
        )}
      >
        {DIRECTION_LABEL[entry.direction]}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-foreground/80",
          expanded ? "whitespace-pre-wrap break-words" : "truncate",
        )}
      >
        {entry.message}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-xs font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  breakAll,
}: {
  label: string;
  value: string;
  breakAll?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right font-mono text-foreground/80",
          breakAll ? "break-all" : "break-words",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Status({ kind, children }: { kind: "loading" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "p-3 text-xs",
        kind === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
