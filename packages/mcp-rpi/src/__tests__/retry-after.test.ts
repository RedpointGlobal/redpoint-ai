/**
 * #27897 — parseRetryAfterMs: turns a Retry-After header into a ms wait for the
 * summarize_interaction_runs 429 backoff. Supports delta-seconds and HTTP-date.
 */
import { describe, it, expect } from "bun:test";
import { parseRetryAfterMs } from "../client/rpi-api.js";

describe("parseRetryAfterMs", () => {
  it("delta-seconds → ms", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("HTTP-date → ms until that time (relative to now)", () => {
    const now = Date.parse("2026-08-23T00:00:00.000Z");
    expect(parseRetryAfterMs("Sun, 23 Aug 2026 00:00:30 GMT", now)).toBe(30_000);
  });

  it("a past HTTP-date clamps to 0, never negative", () => {
    const now = Date.parse("2026-08-23T00:01:00.000Z");
    expect(parseRetryAfterMs("Sun, 23 Aug 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("null / unparseable → undefined", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});
