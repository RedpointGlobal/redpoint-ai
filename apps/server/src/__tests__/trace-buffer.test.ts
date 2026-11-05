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
    clearTrace("ws-A", "u1");
    clearTrace("ws-B", "u1");
  });

  it("appends and retrieves events for a workspace", () => {
    appendTrace("ws-A", "u1", ev("first"));
    appendTrace("ws-A", "u1", ev("second"));
    const trace = getTrace("ws-A", "u1");
    expect(trace).toHaveLength(2);
    expect(trace[0].message).toBe("first");
    expect(trace[1].message).toBe("second");
  });

  it("isolates traces per workspace", () => {
    appendTrace("ws-A", "u1", ev("a-only"));
    appendTrace("ws-B", "u1", ev("b-only"));
    expect(getTrace("ws-A", "u1").map((e) => e.message)).toEqual(["a-only"]);
    expect(getTrace("ws-B", "u1").map((e) => e.message)).toEqual(["b-only"]);
  });

  it("returns an empty array for an unknown workspace", () => {
    expect(getTrace("never-touched", "u1")).toEqual([]);
  });

  it("clearTrace empties the buffer", () => {
    appendTrace("ws-A", "u1", ev("x"));
    appendTrace("ws-A", "u1", ev("y"));
    clearTrace("ws-A", "u1");
    expect(getTrace("ws-A", "u1")).toEqual([]);
  });

  it("ring-buffers at 500 events (oldest dropped on overflow)", () => {
    for (let i = 0; i < 600; i++) {
      appendTrace("ws-A", "u1", ev(`evt-${i}`));
    }
    const trace = getTrace("ws-A", "u1");
    expect(trace).toHaveLength(500);
    // Oldest 100 dropped: first event in buffer should be evt-100
    expect(trace[0].message).toBe("evt-100");
    expect(trace[499].message).toBe("evt-599");
  });

  it("subscribers receive each appended event in order", () => {
    const received: string[] = [];
    const unsub = subscribeTrace("ws-A", "u1", (e) => received.push(e.message));
    appendTrace("ws-A", "u1", ev("one"));
    appendTrace("ws-A", "u1", ev("two"));
    appendTrace("ws-A", "u1", ev("three"));
    unsub();
    expect(received).toEqual(["one", "two", "three"]);
  });

  it("supports multiple subscribers fan-out (every listener gets every event)", () => {
    const a: string[] = [];
    const b: string[] = [];
    const ua = subscribeTrace("ws-A", "u1", (e) => a.push(e.message));
    const ub = subscribeTrace("ws-A", "u1", (e) => b.push(e.message));
    appendTrace("ws-A", "u1", ev("broadcast"));
    ua();
    ub();
    expect(a).toEqual(["broadcast"]);
    expect(b).toEqual(["broadcast"]);
  });

  it("unsubscribe stops further notifications without affecting other subscribers", () => {
    const a: string[] = [];
    const b: string[] = [];
    const ua = subscribeTrace("ws-A", "u1", (e) => a.push(e.message));
    const ub = subscribeTrace("ws-A", "u1", (e) => b.push(e.message));
    appendTrace("ws-A", "u1", ev("first"));
    ua();
    appendTrace("ws-A", "u1", ev("second"));
    ub();
    expect(a).toEqual(["first"]);
    expect(b).toEqual(["first", "second"]);
  });

  it("subscribers are scoped per workspace (no cross-talk)", () => {
    const a: string[] = [];
    const unsub = subscribeTrace("ws-A", "u1", (e) => a.push(e.message));
    appendTrace("ws-B", "u1", ev("for-b"));
    appendTrace("ws-A", "u1", ev("for-a"));
    unsub();
    expect(a).toEqual(["for-a"]);
  });

  it("subscriber error is isolated — siblings still fire and append succeeds", () => {
    const ok: string[] = [];
    const ua = subscribeTrace("ws-A", "u1", () => {
      throw new Error("subscriber blew up");
    });
    const ub = subscribeTrace("ws-A", "u1", (e) => ok.push(e.message));
    expect(() => appendTrace("ws-A", "u1", ev("alive"))).not.toThrow();
    ua();
    ub();
    expect(ok).toEqual(["alive"]);
    expect(getTrace("ws-A", "u1").map((e) => e.message)).toEqual(["alive"]);
  });

  describe("per user (the events carry tool results — B3)", () => {
    beforeEach(() => {
      for (const u of ["alice", "bob"]) clearTrace("ws-S", u);
    });

    it("a user reads only their OWN events in a shared workspace", () => {
      appendTrace("ws-S", "alice", ev("alice's tool result"));
      appendTrace("ws-S", "bob", ev("bob's tool result"));
      expect(getTrace("ws-S", "alice").map((e) => e.message)).toEqual(["alice's tool result"]);
      expect(getTrace("ws-S", "bob").map((e) => e.message)).toEqual(["bob's tool result"]);
    });

    it("clear clears the caller's own events only", () => {
      appendTrace("ws-S", "alice", ev("keep"));
      appendTrace("ws-S", "bob", ev("drop"));
      clearTrace("ws-S", "bob");
      expect(getTrace("ws-S", "alice").map((e) => e.message)).toEqual(["keep"]);
      expect(getTrace("ws-S", "bob")).toEqual([]);
    });

    it("a live subscriber hears only its own user's events", () => {
      const heard: string[] = [];
      const unsub = subscribeTrace("ws-S", "bob", (e) => heard.push(e.message));
      appendTrace("ws-S", "alice", ev("alice-secret"));
      appendTrace("ws-S", "bob", ev("bob-own"));
      unsub();
      expect(heard).toEqual(["bob-own"]);
    });
  });
});
