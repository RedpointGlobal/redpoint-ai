/**
 * Traffic-panel view boundary (#27897 Bug 2).
 *
 * The apps/server trace buffer is process-global and outlives page reloads, so on
 * SSE connect it replays events from a PREVIOUS page view. The panel used to wipe
 * the buffer on open to hide those — which destroyed the current view's own events
 * when the panel was opened after a chat run. Instead we keep the buffer and hide
 * only the replayed events older than this page view's start.
 */

/**
 * True when a telemetry event predates the current page view (a stale replay from
 * a previous page load) and should not be displayed. An unparseable timestamp is
 * NOT treated as stale — better to show an odd row than silently drop real traffic.
 */
export function isBeforePageView(timestampIso: string, pageViewStartMs: number): boolean {
  const t = new Date(timestampIso).getTime();
  return !Number.isNaN(t) && t < pageViewStartMs;
}
