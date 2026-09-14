/**
 * #27897 — current-date grounding, shared by BOTH the orchestrator prompt
 * (apps/server chat route) and the dispatched sub-agent prompt (router.ts).
 *
 * The model otherwise falls back to its training-cutoff date and resolves relative
 * ranges ("this month", "last 30 days") into a PAST window — a 2024 range that
 * returns zero rows for data timestamped 2026. Fix 1 (v7.114) injected this into
 * the orchestrator only; the rpi-interactions SUB-AGENT does the date math and had
 * no current date, so it still computed 2024. One source, injected at BOTH layers
 * at dispatch/request time (GROUNDING_PREAMBLE is a static const and can't hold a
 * dynamic date). UTC, because RPI run timestamps are UTC.
 *
 * v7.130 — the preamble now resolves "this week"/"this month" to CONCRETE windows
 * rather than leaving the arithmetic to the model. The Gulla trace showed "this
 * week" interpreted three different ways across runs (today-only → undercount),
 * because each run re-did the math. Definitions (Mark's call): "this week" = a
 * rolling 7-day window (today-6 → today); "this month" = 1st-of-current-month →
 * today. Emitting the exact YYYY-MM-DD bounds makes the window deterministic.
 */

/** YYYY-MM-DD for a Date, in UTC. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function currentDatePreamble(now: Date = new Date()): string {
  const today = utcDay(now);
  // "This week" = rolling 7 days INCLUSIVE of today: today-6 … today.
  const weekFrom = utcDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed current month
  // "This month" = 1st of the current UTC month … today.
  const monthFrom = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  // "Last month" = the FULL previous calendar month. Date.UTC handles the
  // year/leap boundaries: Date.UTC(y, m, 0) = last day of the previous month;
  // Date.UTC(y, m-1, 1) = its first (January → December of the prior year).
  const lastMonthFrom = utcDay(new Date(Date.UTC(y, m - 1, 1)));
  const lastMonthTo = utcDay(new Date(Date.UTC(y, m, 0)));
  return (
    `Current date: ${now.toISOString()} (UTC). Use this to resolve any relative ` +
    `date range (today, this week, this month, last month, last N days); RPI timestamps are UTC.\n` +
    `Resolve these relative ranges to these EXACT windows (do not recompute):\n` +
    `- "this week" = a rolling 7-day window: fromDate ${weekFrom}, toDate ${today}.\n` +
    `- "this month" = 1st of the current month to today: fromDate ${monthFrom}, toDate ${today}.\n` +
    `- "last month" = the FULL previous calendar month: fromDate ${lastMonthFrom}, toDate ${lastMonthTo}.\n` +
    `- "today" = fromDate ${today}, toDate ${today}.`
  );
}
