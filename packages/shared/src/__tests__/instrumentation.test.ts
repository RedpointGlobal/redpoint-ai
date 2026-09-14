import { describe, it, expect, beforeEach } from "bun:test";
import {
  configureInstrumentation,
  isInstrumentationEnabled,
  emitInstrumentationEvent,
  probeInstrumentationSink,
  type InstrumentationEvent,
  type InstrumentationSink,
} from "../instrumentation.js";

// A complete, valid event fixture (overridable per test).
function makeEvent(
  overrides: Partial<InstrumentationEvent> = {},
): InstrumentationEvent {
  return {
    eventId: "evt-1",
    timestamp: "2026-08-04T00:00:00.000Z",
    userId: "user-1",
    idempotencyKey: "idem-1",
    clientId: "client-1",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 0,
    totalTokens: 150,
    workspaceId: "ws-1",
    runId: "run-1",
    role: "parent",
    ...overrides,
  };
}

/** In-memory sink that records what it received. */
class RecordingSink implements InstrumentationSink {
  events: InstrumentationEvent[] = [];
  write(event: InstrumentationEvent): void {
    this.events.push(event);
  }
}

describe("instrumentation spine", () => {
  // The registry is a module singleton — reset to the disabled default so each
  // test starts clean regardless of order.
  beforeEach(() => configureInstrumentation(null));

  it("is disabled by default (no sink configured)", () => {
    expect(isInstrumentationEnabled()).toBe(false);
  });

  it("emit is a no-op when disabled and never throws", () => {
    expect(() => emitInstrumentationEvent(makeEvent())).not.toThrow();
  });

  it("reports enabled once a sink is configured", () => {
    configureInstrumentation(new RecordingSink());
    expect(isInstrumentationEnabled()).toBe(true);
  });

  it("forwards the event verbatim to the configured sink", () => {
    const sink = new RecordingSink();
    configureInstrumentation(sink);
    const event = makeEvent({ eventId: "evt-xyz", totalTokens: 999 });
    emitInstrumentationEvent(event);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toEqual(event);
  });

  it("configuring null disables again and stops delivery", () => {
    const sink = new RecordingSink();
    configureInstrumentation(sink);
    configureInstrumentation(null);
    expect(isInstrumentationEnabled()).toBe(false);
    emitInstrumentationEvent(makeEvent());
    expect(sink.events).toHaveLength(0);
  });

  it("swallows a synchronously throwing sink (request is never broken)", () => {
    configureInstrumentation({
      write() {
        throw new Error("sink boom");
      },
    });
    expect(() => emitInstrumentationEvent(makeEvent())).not.toThrow();
  });

  it("swallows a rejecting async sink without an unhandled rejection", () => {
    configureInstrumentation({
      write() {
        return Promise.reject(new Error("async sink boom"));
      },
    });
    expect(() => emitInstrumentationEvent(makeEvent())).not.toThrow();
  });

  describe("probeInstrumentationSink", () => {
    it("returns false when disabled (no sink)", async () => {
      expect(await probeInstrumentationSink()).toBe(false);
    });

    it("returns true when the sink declares no probe", async () => {
      configureInstrumentation({ write() {} });
      expect(await probeInstrumentationSink()).toBe(true);
    });

    it("forwards the sink's isWritable result", async () => {
      configureInstrumentation({ write() {}, isWritable: async () => true });
      expect(await probeInstrumentationSink()).toBe(true);
      configureInstrumentation({ write() {}, isWritable: async () => false });
      expect(await probeInstrumentationSink()).toBe(false);
    });

    it("returns false when the probe throws", async () => {
      configureInstrumentation({
        write() {},
        isWritable: async () => {
          throw new Error("probe boom");
        },
      });
      expect(await probeInstrumentationSink()).toBe(false);
    });
  });
});
