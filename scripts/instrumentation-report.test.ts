import { describe, it, expect } from "bun:test";
import {
  parseJsonl,
  dedupeByIdempotency,
  aggregate,
  type InstrumentationEvent,
} from "./instrumentation-report.ts";

function ev(o: Partial<InstrumentationEvent>): InstrumentationEvent {
  return {
    eventId: o.eventId ?? crypto.randomUUID(),
    timestamp: o.timestamp ?? "2026-08-05T00:00:00.000Z",
    userId: o.userId ?? "u1",
    idempotencyKey: o.idempotencyKey ?? "k1",
    clientId: o.clientId ?? "web",
    model: o.model ?? "gpt-4.1",
    provider: o.provider ?? "azure-openai",
    inputTokens: o.inputTokens ?? 0,
    outputTokens: o.outputTokens ?? 0,
    cacheReadTokens: o.cacheReadTokens ?? 0,
    cacheWriteTokens: o.cacheWriteTokens ?? 0,
    reasoningTokens: o.reasoningTokens ?? 0,
    totalTokens: o.totalTokens ?? 0,
    workspaceId: o.workspaceId ?? "w1",
    runId: o.runId ?? "r1",
    role: o.role ?? "parent",
    skillName: o.skillName,
  };
}

describe("parseJsonl", () => {
  it("parses valid lines and skips blank/malformed", () => {
    const text = [
      JSON.stringify(ev({ eventId: "a" })),
      "",
      "   ",
      "{not json",
      JSON.stringify(ev({ eventId: "b" })),
    ].join("\n");
    const out = parseJsonl(text);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.eventId)).toEqual(["a", "b"]);
  });
});

describe("dedupeByIdempotency", () => {
  it("keeps the earliest runId's whole event-set and drops later retries", () => {
    // Request k1, first attempt r1 (parent + sub-agent) at T0/T0.
    // Retry k1, r2 (parent + sub-agent) at a LATER timestamp — must be dropped.
    const events = [
      ev({ idempotencyKey: "k1", runId: "r1", role: "parent", timestamp: "2026-08-05T00:00:00.000Z" }),
      ev({ idempotencyKey: "k1", runId: "r1", role: "sub-agent", skillName: "rpi-audiences", timestamp: "2026-08-05T00:00:01.000Z" }),
      ev({ idempotencyKey: "k1", runId: "r2", role: "parent", timestamp: "2026-08-05T00:05:00.000Z" }),
      ev({ idempotencyKey: "k1", runId: "r2", role: "sub-agent", skillName: "rpi-audiences", timestamp: "2026-08-05T00:05:01.000Z" }),
    ];
    const { kept, dropped } = dedupeByIdempotency(events);
    expect(dropped).toBe(2);
    expect(kept).toHaveLength(2);
    // Parent + sub-agent both preserved (NOT collapsed to one row)
    expect(kept.every((e) => e.runId === "r1")).toBe(true);
    expect(kept.map((e) => e.role).sort()).toEqual(["parent", "sub-agent"]);
  });

  it("keeps distinct idempotencyKeys independently", () => {
    const events = [
      ev({ idempotencyKey: "k1", runId: "r1" }),
      ev({ idempotencyKey: "k2", runId: "r2" }),
    ];
    const { kept, dropped } = dedupeByIdempotency(events);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
  });
});

describe("aggregate", () => {
  it("sums per user (parent + sub-agent) and counts distinct requests", () => {
    const kept = [
      ev({ userId: "u1", idempotencyKey: "k1", role: "parent", inputTokens: 100, outputTokens: 40, totalTokens: 140 }),
      ev({ userId: "u1", idempotencyKey: "k1", role: "sub-agent", skillName: "s1", inputTokens: 200, outputTokens: 50, totalTokens: 250 }),
      ev({ userId: "u1", idempotencyKey: "k2", role: "parent", inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    ];
    const { byUser, bySkill, grand } = aggregate(kept);
    const u1 = byUser.get("u1")!;
    expect(u1.requests.size).toBe(2); // k1, k2
    expect(u1.inputTokens).toBe(310);
    expect(u1.totalTokens).toBe(405);
    // by-skill uses sub-agent events
    expect(bySkill.get("s1")!.totalTokens).toBe(250);
    expect(grand.totalTokens).toBe(405);
  });

  it("breaks out the cache-read / cache-write / reasoning subtotals (for deduction)", () => {
    // input INCLUDES its cached subset; the report must surface cached separately
    // so the discounted portion is visible and deductible downstream.
    const kept = [
      ev({ idempotencyKey: "k1", role: "parent", inputTokens: 1000, cacheReadTokens: 900, outputTokens: 50, reasoningTokens: 0, totalTokens: 1050 }),
      ev({ idempotencyKey: "k1", role: "sub-agent", skillName: "s1", inputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 120, outputTokens: 30, reasoningTokens: 10, totalTokens: 530 }),
    ];
    const { grand } = aggregate(kept);
    expect(grand.inputTokens).toBe(1500);
    expect(grand.cacheReadTokens).toBe(1300); // deductible cached share of input
    expect(grand.cacheWriteTokens).toBe(120);
    expect(grand.outputTokens).toBe(80);
    expect(grand.reasoningTokens).toBe(10);
    // fresh (full-rate) input is derivable: input − cached = 200
    expect(grand.inputTokens - grand.cacheReadTokens).toBe(200);
    // "net" column = total − cached = non-cached volume (fresh input + output)
    expect(grand.totalTokens - grand.cacheReadTokens).toBe(280);
  });
});
