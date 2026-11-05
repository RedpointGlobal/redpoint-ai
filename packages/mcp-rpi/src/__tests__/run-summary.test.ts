/**
 * Server-side run aggregation. Locks the TRUE math that replaces the agent's
 * in-context fabrication: the single reports request (RPI ignores pageNumber, so
 * it never pages), the 429 backoff, the per-interaction grouping (by
 * versionControlID), the bounded per-interaction run counts, and the dashboard
 * (run totals from run-counts, interaction counts, top-N ranked by real runs,
 * and the honest partial notes).
 */
import { describe, it, expect } from "bun:test";
import {
  withRetryOn429,
  fetchInteractionReport,
  dedupeInteractions,
  interactionKey,
  countRunsPerInteraction,
  summarizeInteractionRuns,
  classifyInteractionType,
  fetchRunCounts,
  type RunCountsRequest,
  type RunCountsResults,
} from "../tools/run-summary.js";

describe("withRetryOn429", () => {
  it("retries a 429 (respecting retryAfterMs) then succeeds", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    let n = 0;
    const doCall = async () => {
      n++;
      if (n < 3) throw { status: 429, retryAfterMs: 50 };
      return "ok";
    };
    const r = await withRetryOn429(doCall, { sleep });
    expect(r).toBe("ok");
    expect(n).toBe(3);
    expect(waits).toEqual([50, 50]);
  });

  it("gives up after maxRetries 429s (rethrows)", async () => {
    const sleep = async () => {};
    const doCall = async () => {
      throw { status: 429, retryAfterMs: 1 };
    };
    await expect(withRetryOn429(doCall, { sleep, maxRetries: 2 })).rejects.toMatchObject({ status: 429 });
  });

  it("total-wait cap exhausted → rethrows", async () => {
    const sleep = async () => {};
    const doCall = async () => {
      throw { status: 429, retryAfterMs: 40_000 };
    };
    await expect(withRetryOn429(doCall, { sleep, capMs: 60_000, maxRetries: 9 })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("does NOT retry a non-429 error", async () => {
    let n = 0;
    const doCall = async () => {
      n++;
      throw { status: 500 };
    };
    await expect(withRetryOn429(doCall, { sleep: async () => {} })).rejects.toMatchObject({ status: 500 });
    expect(n).toBe(1);
  });

  it("fires onRetry per backoff with waitMs + retryAfterMs (per-429 logging hook)", async () => {
    const events: Array<{ attempt: number; waitMs: number; retryAfterMs?: number }> = [];
    let n = 0;
    const doCall = async () => {
      n++;
      if (n < 3) throw { status: 429, retryAfterMs: 50 };
      return "ok";
    };
    await withRetryOn429(doCall, { sleep: async () => {}, onRetry: (i) => events.push(i) });
    expect(events).toEqual([
      { attempt: 0, waitMs: 50, retryAfterMs: 50 },
      { attempt: 1, waitMs: 50, retryAfterMs: 50 },
    ]);
  });
});

describe("fetchInteractionReport (one request — RPI ignores pageNumber)", () => {
  const quiet = () => {};

  it("an endpoint that echoes page 1 (currentPage:1, totalNumberOfPages:2) is called ONCE, rows not duplicated", async () => {
    // Live RPI: every pageNumber returns page 1 with the same rows. The old page
    // loop re-fetched page 1 until its 50-page cap: 11 rows came back as 550.
    let calls = 0;
    const fetch = async () => {
      calls++;
      return { results: [{ name: "A" }, { name: "B" }], currentPage: 1, totalNumberOfPages: 2 } as any;
    };
    const res = await fetchInteractionReport(fetch, { log: quiet });
    expect(calls).toBe(1);
    expect(res.rows).toHaveLength(2);
    expect(res.truncated).toBe(true); // more activity than one response holds
  });

  it("totalNumberOfPages 1 → complete, NOT truncated (no false 'incomplete' note)", async () => {
    const res = await fetchInteractionReport(async () => ({ results: [{ name: "A" }], currentPage: 1, totalNumberOfPages: 1 }) as any, { log: quiet });
    expect(res.truncated).toBe(false);
    expect(res.rows).toHaveLength(1);
  });

  it("a throwing fetch → no rows, truncated, no reject", async () => {
    const res = await fetchInteractionReport(async () => { throw new Error("aborted"); }, { log: quiet });
    expect(res.rows).toEqual([]);
    expect(res.truncated).toBe(true);
  });
});

// A report row as RPI returns it: one interaction VERSION. versionControlID names
// every version of the interaction; file.id names this one version.
const rrow = (o: {
  name: string; id?: string; vcid?: string; last?: string; active?: number; assoc?: (boolean | null)[]; executed?: number;
}) =>
  ({
    name: o.name,
    file: { id: o.id ?? `id-${o.name}`, versionControlID: o.vcid ?? `vc-${o.name}` },
    executedWorkflowCount: o.executed ?? 1,
    activeWorkflowCount: o.active ?? 0,
    lastActivityDate: o.last ?? "2026-07-15T00:00:00Z",
    workflowAssociations: (o.assoc ?? []).map((isTest) => ({ isTest })),
  }) as any;

describe("interactionKey + dedupeInteractions (one entry per interaction, across versions)", () => {
  it("keys by versionControlID, NOT file.id — two versions of one interaction are one entry", () => {
    const v1 = rrow({ name: "Daily", id: "ver-1", vcid: "vc-daily", last: "2026-07-10T00:00:00Z", assoc: [true] });
    const v2 = rrow({ name: "Daily", id: "ver-2", vcid: "vc-daily", last: "2026-07-20T00:00:00Z", assoc: [false] });
    expect(interactionKey(v1)).toBe("vc-daily");
    const d = dedupeInteractions([v1, v2, v1]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ key: "vc-daily", name: "Daily", type: "production", lastActivityDate: "2026-07-20T00:00:00Z" });
  });

  it("falls back to file.id when versionControlID is missing or the nil guid", () => {
    expect(interactionKey(rrow({ name: "x", id: "ver-9", vcid: "00000000-0000-0000-0000-000000000000" }))).toBe("ver-9");
    expect(interactionKey({ name: "y", file: { id: "ver-8" } } as any)).toBe("ver-8");
    expect(interactionKey({ name: "z" } as any)).toBe("name:z");
  });

  it("orders most recently active first", () => {
    const d = dedupeInteractions([
      rrow({ name: "old", last: "2026-07-01T00:00:00Z" }),
      rrow({ name: "new", last: "2026-07-30T00:00:00Z" }),
    ]);
    expect(d.map((i) => i.name)).toEqual(["new", "old"]);
  });

  it("classify: production if ANY non-test association; else test (homogeneity rule)", () => {
    expect(classifyInteractionType(rrow({ name: "x", assoc: [true, true] }))).toBe("test");
    expect(classifyInteractionType(rrow({ name: "x", assoc: [true, false] }))).toBe("production");
    expect(classifyInteractionType(rrow({ name: "x", assoc: [] }))).toBe("test"); // no assocs → test
  });
});

describe("countRunsPerInteraction (bounded parallel run-counts calls)", () => {
  it("counts every key, at most `concurrency` calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const countOne = async (k: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return k.length;
    };
    const res = await countRunsPerInteraction(["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "g"], countOne, { concurrency: 3 });
    expect(peak).toBe(3);
    expect(res.complete).toBe(true);
    expect([...res.counts.entries()].sort()).toEqual([["a", 1], ["bb", 2], ["ccc", 3], ["dddd", 4], ["eeeee", 5], ["ffffff", 6], ["g", 1]]);
  });

  it("budget spent → no new calls, complete=false (injected clock)", async () => {
    const clock = { t: 0 };
    let calls = 0;
    const countOne = async () => { calls++; clock.t += 1_000; return 1; };
    const res = await countRunsPerInteraction(["a", "b", "c", "d"], countOne, { concurrency: 1, budgetMs: 2_000, now: () => clock.t });
    expect(calls).toBe(2);
    expect(res.complete).toBe(false);
  });

  it("a failed call is skipped, the rest counted, complete=false", async () => {
    const res = await countRunsPerInteraction(["a", "b"], async (k) => { if (k === "a") throw new Error("500"); return 7; });
    expect([...res.counts.entries()]).toEqual([["b", 7]]);
    expect(res.complete).toBe(false);
  });
});

describe("summarizeInteractionRuns (runs from run-counts, interactions from the report)", () => {
  const W = { fromDate: "2026-07-01", toDate: "2026-07-31" };
  const totals = (total: number, test: number, prod: number) =>
    ({ totalRuns: total, executionModes: [{ executionMode: "Test", resultsCount: test }, { executionMode: "Production", resultsCount: prod }] }) as any;
  const all = (interactions: ReturnType<typeof dedupeInteractions>, counts: [string, number][], complete = true) => ({
    interactions,
    candidates: interactions.map((i) => i.key),
    perInteraction: { counts: new Map(counts), complete },
  });

  it("totalRuns + test/prod runs come from run-counts, NOT Σ executedWorkflowCount", () => {
    // Live RPI: a 5-minute interaction's row says executedWorkflowCount 1; run-counts says 216.
    const ints = dedupeInteractions([rrow({ name: "A", executed: 1 }), rrow({ name: "B", executed: 1 })]);
    const d = summarizeInteractionRuns({ ...W, runTotals: totals(588, 519, 69), ...all(ints, [["vc-A", 216], ["vc-B", 13]]), reportTruncated: false });
    expect(d.totalRuns).toBe(588);
    expect(d.testRuns).toBe(519);
    expect(d.productionRuns).toBe(69);
  });

  it("runsPerInteraction: one entry per interaction, real runs, ranked by runs (not recency), runs>0, top-N", () => {
    const ints = dedupeInteractions([
      rrow({ name: "recent-small", last: "2026-07-30T00:00:00Z", assoc: [false] }),
      rrow({ name: "older-big", id: "v1", vcid: "vc-big", last: "2026-07-05T00:00:00Z", assoc: [true] }),
      rrow({ name: "older-big", id: "v2", vcid: "vc-big", last: "2026-07-06T00:00:00Z", assoc: [true] }),
      rrow({ name: "idle", last: "2026-07-20T00:00:00Z" }),
      rrow({ name: "mid", last: "2026-07-10T00:00:00Z" }),
    ]);
    const d = summarizeInteractionRuns({
      ...W, runTotals: totals(259, 250, 9),
      ...all(ints, [["vc-recent-small", 9], ["vc-big", 216], ["vc-idle", 0], ["vc-mid", 34]]),
      reportTruncated: false, topN: 2,
    });
    expect(d.runsPerInteraction).toEqual([
      { name: "older-big", runs: 216, type: "test" },
      { name: "mid", runs: 34, type: "test" },
    ]);
    expect(d.runsPerInteractionNote).toBeUndefined(); // every interaction counted → exact
  });

  it("interaction counts are per interaction, not per row", () => {
    const ints = dedupeInteractions([
      rrow({ name: "P", id: "p1", vcid: "vc-P", assoc: [false], active: 1 }),
      rrow({ name: "P", id: "p2", vcid: "vc-P", assoc: [false], active: 1 }),
      rrow({ name: "T1", assoc: [true] }),
      rrow({ name: "T2", assoc: [true, true] }),
    ]);
    const d = summarizeInteractionRuns({ ...W, runTotals: totals(0, 0, 0), ...all(ints, []), reportTruncated: false });
    expect(d.productionInteractions).toBe(1);
    expect(d.testInteractions).toBe(2);
    expect(d.activeInteractions).toBe(1);
  });

  it("ranking from part of the interactions → honest note; report still complete → truncated false", () => {
    const ints = dedupeInteractions([rrow({ name: "A", last: "2026-07-30T00:00:00Z" }), rrow({ name: "B", last: "2026-07-01T00:00:00Z" })]);
    const d = summarizeInteractionRuns({
      ...W, runTotals: totals(5, 5, 0), interactions: ints,
      candidates: ["vc-A"], perInteraction: { counts: new Map([["vc-A", 5]]), complete: true },
      reportTruncated: false,
    });
    expect(d.runsPerInteractionNote).toMatch(/1 most recently active of 2/);
    expect(d.truncated).toBe(false);
    expect(d.truncationNote).toBeUndefined();
  });

  it("report truncated → truncationNote (interaction figures partial, totalRuns complete)", () => {
    const ints = dedupeInteractions([rrow({ name: "A" })]);
    const d = summarizeInteractionRuns({ ...W, runTotals: totals(40, 40, 0), ...all(ints, [["vc-A", 40]]), reportTruncated: true });
    expect(d.truncated).toBe(true);
    expect(d.totalRuns).toBe(40);
    expect(d.truncationNote?.toLowerCase()).toMatch(/partial/);
    expect(d.runsPerInteractionNote).toBeDefined();
  });

  it("empty tenant → zeroes, no notes", () => {
    const d = summarizeInteractionRuns({ ...W, runTotals: totals(0, 0, 0), ...all([], []), reportTruncated: false });
    expect(d).toMatchObject({ totalRuns: 0, testRuns: 0, productionRuns: 0, activeInteractions: 0, testInteractions: 0, productionInteractions: 0, runsPerInteraction: [], truncated: false });
    expect(d.truncationNote).toBeUndefined();
    expect(d.runsPerInteractionNote).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Run COUNTS over time (RPI 7.8) — server-side GROUP BY. fetchRunCounts
// is a thin body-builder over the POST reports/interaction/run-counts endpoint:
// it fills the required defaults, forwards optional filters, and returns the
// result verbatim (RPI does the aggregation; we never re-shape or invent it).
// This replaces the interim client-side daily grind.
// ---------------------------------------------------------------------------

describe("fetchRunCounts (body builder over run-counts POST)", () => {
  const RESULT: RunCountsResults = {
    results: [{ date: "2026-08-01", executionModes: [], totalRuns: 3 }],
    executionModes: [],
    totalRuns: 3,
  } as RunCountsResults;

  it("fills required defaults (granularity Day, executionMode All, status, folder perms) and returns the post result", async () => {
    let sent: RunCountsRequest | undefined;
    const post = async (body: RunCountsRequest) => {
      sent = body;
      return RESULT;
    };
    const out = await fetchRunCounts(post, { fromDate: "2026-08-01", toDate: "2026-08-31" });
    expect(out).toBe(RESULT);
    expect(sent).toMatchObject({
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
      granularity: "Day",
      executionMode: "All",
      status: "AllStatuses",
      applyFolderPermissions: false,
    });
    // no optional filters unless supplied
    expect((sent as Record<string, unknown>).interactionID).toBeUndefined();
    expect((sent as Record<string, unknown>).name).toBeUndefined();
  });

  it("honors explicit granularity + executionMode and forwards optional filters", async () => {
    let sent: RunCountsRequest | undefined;
    const post = async (body: RunCountsRequest) => {
      sent = body;
      return RESULT;
    };
    await fetchRunCounts(post, {
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
      granularity: "Month",
      executionMode: "Production",
      interactionID: "abc-123",
      name: "Welcome",
    });
    expect(sent).toMatchObject({
      granularity: "Month",
      executionMode: "Production",
      interactionID: "abc-123",
      name: "Welcome",
    });
  });
});
