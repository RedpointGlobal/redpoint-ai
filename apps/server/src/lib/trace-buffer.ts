import type { TelemetryEvent } from "@redpoint-ai/shared";

/**
 * In-memory per-workspace ring buffer for telemetry events.
 *
 * Used by the chat / agui routes to record TelemetryEvents as the agent
 * runs, and by `GET /api/v1/workspaces/:id/trace` to expose them to the
 * web UI's Traffic export. Process-global Map; no persistence — restart
 * resets the trace, which is the right behavior for dev observability.
 *
 * Cap: 500 events per workspace. Oldest dropped on overflow. Sized to
 * cover several full conversations without unbounded memory growth.
 */

const MAX_EVENTS_PER_WORKSPACE = 500;

const traces = new Map<string, TelemetryEvent[]>();

// Per-workspace subscriber registry. The SSE endpoint registers callbacks
// here so each new appendTrace fan-outs to all live listeners (typically
// just the open Traffic tab in the user's browser, but the model supports
// any number — concurrent dev tabs all see the same stream).
type Subscriber = (event: TelemetryEvent) => void;
const subscribers = new Map<string, Set<Subscriber>>();

export function appendTrace(workspaceId: string, event: TelemetryEvent): void {
  const buf = traces.get(workspaceId) ?? [];
  buf.push(event);
  if (buf.length > MAX_EVENTS_PER_WORKSPACE) {
    buf.splice(0, buf.length - MAX_EVENTS_PER_WORKSPACE);
  }
  traces.set(workspaceId, buf);

  // Fan out to live subscribers. Failures are isolated — one broken
  // subscriber won't take down the others or disrupt the trace append.
  const subs = subscribers.get(workspaceId);
  if (subs) {
    for (const cb of subs) {
      try {
        cb(event);
      } catch {
        // ignore — subscriber error shouldn't propagate into the agent path
      }
    }
  }
}

export function getTrace(workspaceId: string): TelemetryEvent[] {
  return traces.get(workspaceId) ?? [];
}

export function clearTrace(workspaceId: string): void {
  traces.delete(workspaceId);
}

export function subscribeTrace(
  workspaceId: string,
  callback: Subscriber,
): () => void {
  const set = subscribers.get(workspaceId) ?? new Set();
  set.add(callback);
  subscribers.set(workspaceId, set);
  return () => {
    set.delete(callback);
    if (set.size === 0) subscribers.delete(workspaceId);
  };
}

// ---------------------------------------------------------------------------
// Helper: build a one-line `message` summary for a TelemetryEvent.
// Mirrors terminal-agent telemetry.ts truncate / formatDuration patterns.
// ---------------------------------------------------------------------------

export function truncateForMessage(value: unknown, max = 60): string {
  if (value === undefined || value === null) return "";
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
