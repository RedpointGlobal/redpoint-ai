import type { components } from "../client/rpi-types.js";

/**
 * #27897 — interaction dashboard aggregation. TWO paths:
 *
 * 1) SUMMARY (default, fast ~1-2s) — built purely from the reports/interaction
 *    endpoint (paginated, RPI-computed counts). Complete + cannot hang.
 * 2) DAILY (opt-in, SLOW ~2min) — a per-day test/prod time series, ground out of
 *    the raw workflow-instances endpoint by adaptive date-chunking (that endpoint
 *    is super-linear in PageSize, so we grind it at PS=10 in small windows). Only
 *    for an explicit per-day / daily-trend request; hard-capped to ~1 month.
 *
 * All aggregators are pure (fetch injected) → unit-testable without a live RPI.
 */

// ---------------------------------------------------------------------------
// 429 backoff (#27897 option B). The report-page fetches are RPI-side, SEQUENTIAL,
// and bounded; on a 429 respect Retry-After with a bounded retry so a transient limit
// doesn't fail the summary. sleep/now injected → unit-testable without real waits.
// ---------------------------------------------------------------------------

export interface RetryError {
  status?: number;
  /** Milliseconds to wait, parsed from Retry-After by the caller. */
  retryAfterMs?: number;
}

export async function withRetryOn429<T>(
  doCall: () => Promise<T>,
  opts?: {
    maxRetries?: number;
    capMs?: number;
    defaultWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Called before each backoff sleep — for per-429 diagnostic logging. */
    onRetry?: (info: { attempt: number; waitMs: number; retryAfterMs?: number }) => void;
  },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 4;
  const capMs = opts?.capMs ?? 60_000;
  const defaultWaitMs = opts?.defaultWaitMs ?? 1_000;
  const sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;
  let waited = 0;
  for (;;) {
    try {
      return await doCall();
    } catch (err) {
      const e = err as RetryError;
      if (e?.status !== 429 || attempt >= maxRetries) throw err;
      // Retry-After if given, else exponential backoff; each wait capped, total capped.
      const backoff = e.retryAfterMs ?? defaultWaitMs * 2 ** attempt;
      const wait = Math.min(backoff, capMs);
      if (waited + wait > capMs) throw err; // total-wait budget exhausted
      opts?.onRetry?.({ attempt, waitMs: wait, retryAfterMs: e.retryAfterMs });
      await sleep(wait);
      waited += wait;
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------
// reports/interaction pagination (#27897 option B). RPI-COMPUTED, COMPLETE
// per-interaction counts with REAL pagination (pageNumber / totalNumberOfPages) —
// the sole source for the dashboard. fetchPage injected → pure + unit-testable;
// live 429 backoff + per-call timeout live in the caller.
// ---------------------------------------------------------------------------

type ReportRow = components["schemas"]["WorkflowFileSummaryJsonResponseMessage"];

export interface ReportPage {
  results?: ReportRow[] | null;
  currentPage?: number;
  totalNumberOfPages?: number;
  count?: number;
}

export interface ReportCollectResult {
  rows: ReportRow[];
  pages: number;
  /** Reports pagination bounded out (very dense tenant). Logged; does NOT flip the
   *  summary's chart-scoped `truncated` (headline stays complete per option A). */
  truncated: boolean;
  elapsedMs: number;
}

export async function collectReportPages(
  fetchPage: (pageNumber: number) => Promise<ReportPage>,
  opts?: { maxPages?: number; budgetMs?: number; now?: () => number; log?: (m: string) => void },
): Promise<ReportCollectResult> {
  const maxPages = opts?.maxPages ?? 50;
  const budgetMs = opts?.budgetMs ?? 30_000;
  const now = opts?.now ?? (() => Date.now());
  const log = opts?.log ?? ((m: string) => console.error(m));
  const start = now();
  const rows: ReportRow[] = [];
  let page = 1;
  let total = 1;
  let truncated = false;
  for (;;) {
    if (page > maxPages || now() - start >= budgetMs) {
      truncated = true;
      break;
    }
    let resp: ReportPage;
    try {
      resp = await fetchPage(page);
    } catch {
      // Per-call failure/timeout → keep the pages we have, mark partial, stop.
      truncated = true;
      break;
    }
    rows.push(...(resp.results ?? []));
    total = resp.totalNumberOfPages ?? 1;
    const cur = resp.currentPage ?? page;
    if (cur >= total) break;
    page++;
  }
  const elapsedMs = now() - start;
  log(
    `[summarize_interaction_runs] reports pagesFetched=${page} rows=${rows.length} ` +
      `totalPages=${total} elapsedMs=${elapsedMs} truncated=${truncated}`,
  );
  return { rows, pages: page, truncated, elapsedMs };
}

// ---------------------------------------------------------------------------
// Option B (#27897) — the reports-derived interaction dashboard. workflow-instances
// is super-linear/unusable (PS=25 ~22s, PS=255 timeout even on a 3-run tenant), so
// the dashboard is built PURELY from reports/interaction: complete + fast (~1-2s),
// cannot hang by construction. Per-run daily buckets are dropped (no fast per-run
// source); test/prod is at the INTERACTION grain (labelled as such, not runs).
// ---------------------------------------------------------------------------

export interface InteractionRunEntry {
  name: string;
  runs: number;
  type: "test" | "production";
}

export interface ReportDashboard {
  window: { fromDate: string; toDate: string };
  totalRuns: number;
  activeInteractions: number;
  /** Interactions classified test (donut). */
  testInteractions: number;
  /** Interactions classified production (donut). */
  productionInteractions: number;
  /** Top-N interactions by run count (horizontal bar). */
  runsPerInteraction: InteractionRunEntry[];
  /** Reports pagination bounded out (very dense tenant) — figures then partial. */
  truncated: boolean;
  truncationNote?: string;
}

/**
 * Classify an interaction test vs production by its associations (homogeneity
 * rule): PRODUCTION if it has at least one non-test (isTest === false) association,
 * else TEST. An interaction with only test associations (or none) is test.
 */
export function classifyInteractionType(row: ReportRow): "test" | "production" {
  const assocs = row.workflowAssociations ?? [];
  return assocs.some((a) => a?.isTest === false) ? "production" : "test";
}

export function summarizeInteractionReports(
  rows: ReportRow[],
  opts: { fromDate: string; toDate: string; truncated: boolean; topN?: number },
): ReportDashboard {
  const topN = opts.topN ?? 10;
  let totalRuns = 0;
  let activeInteractions = 0;
  let testInteractions = 0;
  let productionInteractions = 0;
  const entries: InteractionRunEntry[] = [];

  for (const r of rows) {
    const runs = r.executedWorkflowCount ?? 0;
    totalRuns += runs;
    if ((r.activeWorkflowCount ?? 0) > 0) activeInteractions++;
    const type = classifyInteractionType(r);
    if (type === "production") productionInteractions++;
    else testInteractions++;
    entries.push({ name: r.name ?? "(unnamed)", runs, type });
  }

  const runsPerInteraction = entries
    .filter((e) => e.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
    .slice(0, topN);

  return {
    window: { fromDate: opts.fromDate, toDate: opts.toDate },
    totalRuns,
    activeInteractions,
    testInteractions,
    productionInteractions,
    runsPerInteraction,
    truncated: opts.truncated,
    ...(opts.truncated
      ? {
          truncationNote: `This tenant has more interactions than fit the fetch budget, so these figures are PARTIAL. Tell the user the summary is incomplete and to narrow the date range.`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// RUN-COUNTS (#27957 / RPI 7.8) — server-side counts by time-bucket + execution
// mode. REPLACES the interim daily grind: RPI 7.8 does the GROUP BY on the POST
// reports/interaction/run-counts endpoint, returning small date-ordered buckets
// in ONE call (no run-by-run grind, no date-chunking, no budget). fetch injected
// → unit-testable without a live RPI.
// ---------------------------------------------------------------------------

export type RunCountGranularity = "Day" | "Week" | "Month";
export type RunCountExecutionMode = "All" | "Test" | "Production";

/** Generated wire types (from the RPI 7.8 spec) — never hand-typed. */
export type RunCountsRequest =
  components["schemas"]["InteractionRunCountsFilterJsonRequestMessage"];
export type RunCountsResults =
  components["schemas"]["InteractionRunCountsResultsJsonResponseMessage"];
export type RunCountBucket =
  components["schemas"]["InteractionRunCountBucketJsonResponseMessage"];

export interface RunCountsParams {
  fromDate: string;
  toDate: string;
  granularity?: RunCountGranularity;
  executionMode?: RunCountExecutionMode;
  /** Optional filter to a single interaction (by id or name). */
  interactionID?: string;
  name?: string;
}

/**
 * Fetch server-side run counts (by time bucket + execution mode) from the RPI 7.8
 * run-counts endpoint. A DUMB fetch: it fills the required request fields with
 * dashboard-appropriate defaults (granularity Day, executionMode All, status
 * AllStatuses = every run state, applyFolderPermissions false = tenant-wide count)
 * and returns the structured results verbatim (results[] buckets ordered by date,
 * per-bucket executionModes, overall executionModes + totalRuns). No shaping — the
 * dashboard templateFn owns assembly.
 */
export async function fetchRunCounts(
  post: (body: RunCountsRequest) => Promise<RunCountsResults>,
  params: RunCountsParams,
): Promise<RunCountsResults> {
  const body: RunCountsRequest = {
    fromDate: params.fromDate,
    toDate: params.toDate,
    granularity: params.granularity ?? "Day",
    executionMode: params.executionMode ?? "All",
    status: "AllStatuses",
    applyFolderPermissions: false,
    ...(params.interactionID ? { interactionID: params.interactionID } : {}),
    ...(params.name ? { name: params.name } : {}),
  } as RunCountsRequest;
  return post(body);
}
