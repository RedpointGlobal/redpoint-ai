/**
 * #27897 Bug 2 — the traffic-panel view boundary. These lock the exact rule that
 * replaced the destructive on-open buffer clear: hide a PREVIOUS page view's
 * replayed events, keep THIS view's own (including a run made before the panel was
 * opened).
 */
import { describe, it, expect } from "bun:test";
import { isBeforePageView } from "../trace-view.js";

// Page view started at t=1000 (ms epoch, stand-in for performance.timeOrigin).
const START = 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("isBeforePageView", () => {
  it("hides an event from before this page view (stale replay)", () => {
    expect(isBeforePageView(iso(500), START)).toBe(true);
  });

  it("keeps an event from after this page view started (this view's traffic)", () => {
    expect(isBeforePageView(iso(1500), START)).toBe(false);
  });

  it("keeps an event exactly at the boundary (not strictly before)", () => {
    expect(isBeforePageView(iso(START), START)).toBe(false);
  });

  it("keeps a run that happened before the panel opened but after page load", () => {
    // The exact bug: page loads (START), user sends a chart request (rich events
    // at 1200), THEN opens the panel. Those events must survive.
    expect(isBeforePageView(iso(1200), START)).toBe(false);
  });

  it("does NOT drop an event with an unparseable timestamp (show, don't hide)", () => {
    expect(isBeforePageView("not-a-date", START)).toBe(false);
  });
});
