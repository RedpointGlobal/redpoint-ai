/**
 * The rate-limit budget (../rate-limit.ts). mcp-drh wires only the per-peer flood
 * ceiling (env-credential mode), but the WindowBudget it rests on is covered here:
 * a fixed window, a refusal with Retry-After, bounded key tracking.
 */
import { describe, it, expect } from "bun:test";
import { WindowBudget, RATE_WINDOW_MS, MAX_REQUESTS_PER_PEER, MAX_REQUESTS_PER_USER, MAX_TRACKED_CLIENTS } from "../rate-limit.js";

describe("WindowBudget", () => {
  it("allows up to the limit, then refuses with the seconds left in the window", () => {
    let now = 1_000_000;
    const b = new WindowBudget(3, () => now);
    expect([b.take("a"), b.take("a"), b.take("a")].every((r) => r.ok)).toBe(true);
    const refused = b.take("a");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSec).toBe(RATE_WINDOW_MS / 1000);
  });
  it("the window resets after RATE_WINDOW_MS", () => {
    let now = 0;
    const b = new WindowBudget(1, () => now);
    expect(b.take("a").ok).toBe(true);
    expect(b.take("a").ok).toBe(false);
    now += RATE_WINDOW_MS;
    expect(b.take("a").ok).toBe(true);
  });
  it("keys are independent", () => {
    let now = 0;
    const b = new WindowBudget(1, () => now);
    expect(b.take("a").ok).toBe(true);
    expect(b.take("b").ok).toBe(true);
  });
  it("tracks at most MAX_TRACKED_CLIENTS keys (oldest dropped)", () => {
    let now = 0;
    const b = new WindowBudget(1, () => now);
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 100; i++) b.take(`k${i}`);
    expect(b.trackedKeys).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
  });
  it("the peer ceiling is 10× the per-user budget", () => {
    expect(MAX_REQUESTS_PER_PEER).toBe(10 * MAX_REQUESTS_PER_USER);
  });
});
