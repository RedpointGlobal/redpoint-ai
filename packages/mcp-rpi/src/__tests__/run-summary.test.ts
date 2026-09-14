/**
 * #27897 — server-side run aggregation (option B, reports-derived). Locks the TRUE
 * math that replaces the agent's in-context fabrication: the reports-page collector
 * (paging + bounds + partial-on-error), the 429 backoff, and the interaction-report
 * dashboard summary (totals, active/test/production interaction counts, top-N
 * runs-per-interaction, and the surfaced truncation flag).
 */
import { describe, it, expect } from "bun:test";
import {
  withRetryOn429,
  collectReportPages,
  summarizeInteractionReports,
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

describe("collectReportPages", () => {
  const quiet = () => {};
  const page = (results: unknown[], currentPage: number, totalNumberOfPages: number) =>
    ({ results, currentPage, totalNumberOfPages }) as any;

  it("single page → one call", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return page([{ executedWorkflowCount: 1 }], 1, 1);
    };
    const res = await collectReportPages(fetch, { log: quiet });
    expect(calls).toBe(1);
    expect(res.rows).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it("multi-page → loops until currentPage>=totalNumberOfPages, concatenates", async () => {
    const fetch = async (p: number) => page([{ executedWorkflowCount: p }], p, 3);
    const res = await collectReportPages(fetch, { log: quiet });
    expect(res.pages).toBe(3);
    expect(res.rows.map((r: any) => r.executedWorkflowCount)).toEqual([1, 2, 3]);
    expect(res.truncated).toBe(false);
  });

  it("page cap → truncated, bounded", async () => {
    const fetch = async (p: number) => page([{ executedWorkflowCount: p }], p, 999);
    const res = await collectReportPages(fetch, { maxPages: 2, log: quiet });
    expect(res.truncated).toBe(true);
    expect(res.rows.length).toBeLessThanOrEqual(2);
  });

  it("wall-clock budget → truncated (injected clock)", async () => {
    const clock = { t: 0 };
    const fetch = async (p: number) => {
      clock.t += 20_000;
      return page([{ executedWorkflowCount: p }], p, 999);
    };
    const res = await collectReportPages(fetch, { budgetMs: 10_000, now: () => clock.t, log: quiet });
    expect(res.truncated).toBe(true);
  });

  it("a throwing fetch → truncated, keeps prior rows, no reject (AbortController backstop)", async () => {
    let n = 0;
    const fetch = async (p: number) => {
      n++;
      if (n === 1) return { results: [{ executedWorkflowCount: 1 }], currentPage: 1, totalNumberOfPages: 5 } as any;
      throw new Error("aborted");
    };
    const res = await collectReportPages(fetch, { log: quiet });
    expect(res.truncated).toBe(true);
    expect(res.rows).toHaveLength(1); // page 1 kept; page 2 aborted
  });
});

describe("summarizeInteractionReports (option B — reports-derived dashboard)", () => {
  const OPT = { fromDate: "2026-07-01", toDate: "2026-07-31", truncated: false };
  const row = (o: {
    name: string; executed: number; active?: number; assoc?: (boolean | null)[];
  }) =>
    ({
      name: o.name,
      executedWorkflowCount: o.executed,
      activeWorkflowCount: o.active ?? 0,
      workflowAssociations: (o.assoc ?? []).map((isTest) => ({ isTest })),
    }) as any;

  it("totalRuns = Σ executedWorkflowCount; activeInteractions = count with active>0", () => {
    const d = summarizeInteractionReports(
      [row({ name: "A", executed: 10, active: 2 }), row({ name: "B", executed: 5, active: 0 }), row({ name: "C", executed: 3, active: 1 })],
      OPT,
    );
    expect(d.totalRuns).toBe(18);
    expect(d.activeInteractions).toBe(2);
  });

  it("classify: production if ANY non-test association; else test (homogeneity rule)", () => {
    expect(classifyInteractionType(row({ name: "x", executed: 1, assoc: [true, true] }))).toBe("test");
    expect(classifyInteractionType(row({ name: "x", executed: 1, assoc: [true, false] }))).toBe("production");
    expect(classifyInteractionType(row({ name: "x", executed: 1, assoc: [] }))).toBe("test"); // no assocs → test
  });

  it("test/production interaction counts for the doughnut", () => {
    const d = summarizeInteractionReports(
      [
        row({ name: "prod", executed: 1, assoc: [false] }),
        row({ name: "test1", executed: 1, assoc: [true] }),
        row({ name: "test2", executed: 1, assoc: [true, true] }),
      ],
      OPT,
    );
    expect(d.productionInteractions).toBe(1);
    expect(d.testInteractions).toBe(2);
  });

  it("runsPerInteraction: top-N by runs desc, runs>0 only, name tie-break, carries type", () => {
    const d = summarizeInteractionReports(
      [
        row({ name: "big", executed: 50, assoc: [false] }),
        row({ name: "mid", executed: 20, assoc: [true] }),
        row({ name: "zero", executed: 0, assoc: [true] }), // dropped (runs=0)
        row({ name: "small", executed: 5, assoc: [true] }),
      ],
      { ...OPT, topN: 2 },
    );
    expect(d.runsPerInteraction).toEqual([
      { name: "big", runs: 50, type: "production" },
      { name: "mid", runs: 20, type: "test" },
    ]);
  });

  it("empty tenant → zeroes, no note", () => {
    const d = summarizeInteractionReports([], OPT);
    expect(d.totalRuns).toBe(0);
    expect(d.activeInteractions).toBe(0);
    expect(d.testInteractions).toBe(0);
    expect(d.productionInteractions).toBe(0);
    expect(d.runsPerInteraction).toEqual([]);
    expect(d.truncated).toBe(false);
    expect(d.truncationNote).toBeUndefined();
  });

  it("truncated → surfaced note", () => {
    const d = summarizeInteractionReports([row({ name: "A", executed: 1 })], { ...OPT, truncated: true });
    expect(d.truncated).toBe(true);
    expect(d.truncationNote?.toLowerCase()).toMatch(/partial|narrow|incomplete/);
  });
});

// ---------------------------------------------------------------------------
// Run COUNTS over time (#27957 / RPI 7.8) — server-side GROUP BY. fetchRunCounts
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
