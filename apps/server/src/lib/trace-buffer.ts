import type { TelemetryEvent } from "@redpoint-ai/shared";

/**
 * In-memory ring buffer of telemetry events, per workspace AND PER USER.
 *
 * Used by the chat / agui routes to record TelemetryEvents as the agent
 * runs, and by `GET /api/v1/workspaces/:id/trace` (+ its SSE stream) to expose
 * them to the web UI's Traffic export. The events carry each tool call's
 * arguments and RESULT — data the caller fetched under their own RPI
 * permissions — and the workspaces are shared, so the buffer is keyed by
 * (workspace, user): a caller reads, follows and clears their OWN events only.
 * Process-global Map; no persistence — restart resets the trace.
 *
 * Cap: 500 events per (workspace, user). Oldest dropped on overflow.
 */

const MAX_EVENTS_PER_WORKSPACE = 500;

const traces = new Map<string, TelemetryEvent[]>();

// Per-(workspace, user) subscriber registry. The SSE endpoint registers
// callbacks here so each new appendTrace fans out to that user's live
// listeners (typically their open Traffic tab).
type Subscriber = (event: TelemetryEvent) => void;
const subscribers = new Map<string, Set<Subscriber>>();

/** The buffer key: one workspace, one user. */
const keyOf = (workspaceId: string, userId: string) => `${workspaceId}\u0000${userId}`;

export function appendTrace(workspaceId: string, userId: string, event: TelemetryEvent): void {
  const key = keyOf(workspaceId, userId);
  const buf = traces.get(key) ?? [];
  buf.push(event);
  if (buf.length > MAX_EVENTS_PER_WORKSPACE) {
    buf.splice(0, buf.length - MAX_EVENTS_PER_WORKSPACE);
  }
  traces.set(key, buf);

  // Fan out to live subscribers. Failures are isolated — one broken
  // subscriber won't take down the others or disrupt the trace append.
  const subs = subscribers.get(key);
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

/** The caller's own events in a workspace. */
export function getTrace(workspaceId: string, userId: string): TelemetryEvent[] {
  return traces.get(keyOf(workspaceId, userId)) ?? [];
}

/** Clear the caller's own events in a workspace (never another user's). */
export function clearTrace(workspaceId: string, userId: string): void {
  traces.delete(keyOf(workspaceId, userId));
}

/** Follow the caller's own new events in a workspace. */
export function subscribeTrace(
  workspaceId: string,
  userId: string,
  callback: Subscriber,
): () => void {
  const key = keyOf(workspaceId, userId);
  const set = subscribers.get(key) ?? new Set();
  set.add(callback);
  subscribers.set(key, set);
  return () => {
    set.delete(callback);
    if (set.size === 0) subscribers.delete(key);
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
