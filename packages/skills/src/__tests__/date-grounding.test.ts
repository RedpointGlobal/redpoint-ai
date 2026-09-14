/**
 * #27897 — current-date grounding. Shared by the orchestrator prompt AND the
 * dispatched sub-agent prompt (router.ts) so relative ranges resolve to the
 * present, not the model's training cutoff.
 */
import { describe, it, expect } from "bun:test";
import { currentDatePreamble } from "../date-grounding.js";

describe("currentDatePreamble", () => {
  it("states the given date in ISO UTC", () => {
    const s = currentDatePreamble(new Date("2026-08-23T12:34:56.000Z"));
    expect(s).toContain("2026-08-23T12:34:56.000Z");
    expect(s).toContain("(UTC)");
  });

  it("tells the model to resolve relative ranges with it", () => {
    const s = currentDatePreamble(new Date("2026-01-01T00:00:00.000Z")).toLowerCase();
    expect(s).toContain("relative");
    expect(s).toMatch(/this month|last n days/);
  });

  it("defaults to now (real current year, not a stale cutoff)", () => {
    const year = Number(currentDatePreamble().slice("Current date: ".length, "Current date: ".length + 4));
    expect(year).toBeGreaterThanOrEqual(2026);
  });

  it("resolves 'this week' to a concrete rolling 7-day window (today-6 → today)", () => {
    const s = currentDatePreamble(new Date("2026-08-24T15:00:00.000Z"));
    // today-6 = 2026-08-18; today = 2026-08-24
    expect(s).toContain('"this week" = a rolling 7-day window: fromDate 2026-08-18, toDate 2026-08-24');
  });

  it("resolves 'this month' to 1st-of-month → today", () => {
    const s = currentDatePreamble(new Date("2026-08-24T15:00:00.000Z"));
    expect(s).toContain('"this month" = 1st of the current month to today: fromDate 2026-08-01, toDate 2026-08-24');
  });

  it("week window spans a month boundary correctly (rolling, not clamped)", () => {
    // 2026-09-03 → today-6 = 2026-08-28 (crosses into the previous month)
    const s = currentDatePreamble(new Date("2026-09-03T09:00:00.000Z"));
    expect(s).toContain("fromDate 2026-08-28, toDate 2026-09-03");
    expect(s).toContain('"this month" = 1st of the current month to today: fromDate 2026-09-01, toDate 2026-09-03');
  });

  it("resolves 'today' to a same-day window", () => {
    const s = currentDatePreamble(new Date("2026-08-24T15:00:00.000Z"));
    expect(s).toContain('"today" = fromDate 2026-08-24, toDate 2026-08-24');
  });

  it("resolves 'last month' to the FULL previous calendar month", () => {
    // resolving in August → last month = July 1..July 31
    const s = currentDatePreamble(new Date("2026-08-15T12:00:00.000Z"));
    expect(s).toContain('"last month" = the FULL previous calendar month: fromDate 2026-07-01, toDate 2026-07-31');
  });

  it("last month handles a short-month boundary (March → February, non-leap)", () => {
    const s = currentDatePreamble(new Date("2026-03-10T00:00:00.000Z"));
    expect(s).toContain("fromDate 2026-02-01, toDate 2026-02-28");
  });

  it("last month handles a leap February (2028)", () => {
    const s = currentDatePreamble(new Date("2028-03-10T00:00:00.000Z"));
    expect(s).toContain("fromDate 2028-02-01, toDate 2028-02-29");
  });

  it("last month handles the January → December-of-prior-year boundary", () => {
    const s = currentDatePreamble(new Date("2026-01-15T00:00:00.000Z"));
    expect(s).toContain('"last month" = the FULL previous calendar month: fromDate 2025-12-01, toDate 2025-12-31');
  });
});
