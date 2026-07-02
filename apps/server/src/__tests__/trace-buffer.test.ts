import { describe, it, expect, beforeEach } from "bun:test";
import type { TelemetryEvent } from "@redpoint-ai/shared";
import {
  appendTrace,
  getTrace,
  clearTrace,
  subscribeTrace,
} from "../lib/trace-buffer.js";

function ev(message: string, type: TelemetryEvent["type"] = "tool-call"): TelemetryEvent {
  return {
    timestamp: new Date().toISOString(),
    direction: "ToMCP",
    type,
    message,
  };
}

describe("trace-buffer", () => {
  beforeEach(() => {
    // Process-global Map; reset both workspaces these tests use to keep
    // each test isolated from siblings.
    clearTrace("ws-A");
    clearTrace("ws-B");
  });

  it("appends and retrieves events for a workspace", () => {
    appendTrace("ws-A", ev("first"));
    appendTrace("ws-A", ev("second"));
    const trace = getTrace("ws-A");
    expect(trace).toHaveLength(2);
    expect(trace[0].message).toBe("first");
    expect(trace[1].message).toBe("second");
  });

  it("isolates traces per workspace", () => {
    appendTrace("ws-A", ev("a-only"));
    appendTrace("ws-B", ev("b-only"));
    expect(getTrace("ws-A").map((e) => e.message)).toEqual(["a-only"]);
    expect(getTrace("ws-B").map((e) => e.message)).toEqual(["b-only"]);
  });

  it("returns an empty array for an unknown workspace", () => {
    expect(getTrace("never-touched")).toEqual([]);
  });

  it("clearTrace empties the buffer", () => {
    appendTrace("ws-A", ev("x"));
    appendTrace("ws-A", ev("y"));
    clearTrace("ws-A");
    expect(getTrace("ws-A")).toEqual([]);
  });

  it("ring-buffers at 500 events (oldest dropped on overflow)", () => {
    for (let i = 0; i < 600; i++) {
      appendTrace("ws-A", ev(`evt-${i}`));
    }
    const trace = getTrace("ws-A");
    expect(trace).toHaveLength(500);
    // Oldest 100 dropped: first event in buffer should be evt-100
    expect(trace[0].message).toBe("evt-100");
    expect(trace[499].message).toBe("evt-599");
  });

  it("subscribers receive each appended event in order", () => {
    const received: string[] = [];
    const unsub = subscribeTrace("ws-A", (e) => received.push(e.message));
    appendTrace("ws-A", ev("one"));
    appendTrace("ws-A", ev("two"));
    appendTrace("ws-A", ev("three"));
    unsub();
    expect(received).toEqual(["one", "two", "three"]);
  });

  it("supports multiple subscribers fan-out (every listener gets every event)", () => {
    const a: string[] = [];
    const b: string[] = [];
    const ua = subscribeTrace("ws-A", (e) => a.push(e.message));
    const ub = subscribeTrace("ws-A", (e) => b.push(e.message));
    appendTrace("ws-A", ev("broadcast"));
    ua();
    ub();
    expect(a).toEqual(["broadcast"]);
    expect(b).toEqual(["broadcast"]);
  });

  it("unsubscribe stops further notifications without affecting other subscribers", () => {
    const a: string[] = [];
    const b: string[] = [];
    const ua = subscribeTrace("ws-A", (e) => a.push(e.message));
    const ub = subscribeTrace("ws-A", (e) => b.push(e.message));
    appendTrace("ws-A", ev("first"));
    ua();
    appendTrace("ws-A", ev("second"));
    ub();
    expect(a).toEqual(["first"]);
    expect(b).toEqual(["first", "second"]);
  });

  it("subscribers are scoped per workspace (no cross-talk)", () => {
    const a: string[] = [];
    const unsub = subscribeTrace("ws-A", (e) => a.push(e.message));
    appendTrace("ws-B", ev("for-b"));
    appendTrace("ws-A", ev("for-a"));
    unsub();
    expect(a).toEqual(["for-a"]);
  });

  it("subscriber error is isolated — siblings still fire and append succeeds", () => {
    const ok: string[] = [];
    const ua = subscribeTrace("ws-A", () => {
      throw new Error("subscriber blew up");
    });
    const ub = subscribeTrace("ws-A", (e) => ok.push(e.message));
    expect(() => appendTrace("ws-A", ev("alive"))).not.toThrow();
    ua();
    ub();
    expect(ok).toEqual(["alive"]);
    expect(getTrace("ws-A").map((e) => e.message)).toEqual(["alive"]);
  });
});
