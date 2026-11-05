import type { components } from "../client/rpi-types.js";

/**
 * Interaction dashboard aggregation. TWO paths:
 *
 * 1) SUMMARY (default, fast ~1-2s) — interactions from ONE reports/interaction
 *    request, runs from the run-counts endpoint (tenant-wide + per interaction,
 *    bounded). Cannot hang.
 * 2) DAILY (opt-in, SLOW ~2min) — a per-day test/prod time series, ground out of
 *    the raw workflow-instances endpoint by adaptive date-chunking (that endpoint
 *    is super-linear in PageSize, so we grind it at PS=10 in small windows). Only
 *    for an explicit per-day / daily-trend request; hard-capped to ~1 month.
 *
 * All aggregators are pure (fetch injected) → unit-testable without a live RPI.
 */

// ---------------------------------------------------------------------------
// 429 backoff. The report-page fetches are RPI-side, SEQUENTIAL,
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
// reports/interaction — ONE request, never paginated. RPI ignores `pageNumber`
// on this endpoint: every page number returns page 1 (currentPage:1) and the same
// rows, so a page loop only re-fetches page 1 and duplicates every row. pageSize
// applies to a grain BELOW the per-interaction grouping; at the 255 maximum a
// response with totalNumberOfPages > 1 means the tenant had more activity than
// one response holds → the interaction list is partial (truncated). Rows are
// one per interaction VERSION. fetchPage injected → pure + unit-testable.
// ---------------------------------------------------------------------------

type ReportRow = components["schemas"]["WorkflowFileSummaryJsonResponseMessage"];

export interface ReportPage {
  results?: ReportRow[] | null;
  currentPage?: number;
  totalNumberOfPages?: number;
  count?: number;
}

export interface ReportFetchResult {
  rows: ReportRow[];
  /** The one response did not hold every interaction (totalNumberOfPages > 1), or the call failed. */
  truncated: boolean;
  elapsedMs: number;
}

export async function fetchInteractionReport(
  fetchPage: () => Promise<ReportPage>,
  opts?: { now?: () => number; log?: (m: string) => void },
): Promise<ReportFetchResult> {
  const now = opts?.now ?? (() => Date.now());
  const log = opts?.log ?? ((m: string) => console.error(m));
  const start = now();
  let rows: ReportRow[] = [];
  let truncated: boolean;
  let totalPages: number | string = "?";
  try {
    const resp = await fetchPage();
    rows = resp.results ?? [];
    totalPages = resp.totalNumberOfPages ?? 1;
    truncated = totalPages > 1;
  } catch {
    // Failure/timeout → no interaction list; the run totals come from run-counts.
    truncated = true;
  }
  const elapsedMs = now() - start;
  log(
    `[summarize_interaction_runs] report rows=${rows.length} totalPages=${totalPages} ` +
      `elapsedMs=${elapsedMs} truncated=${truncated}`,
  );
  return { rows, truncated, elapsedMs };
}

// ---------------------------------------------------------------------------
// The interaction dashboard. Interactions come from reports/interaction (one
// row per interaction VERSION); RUNS come from the run-counts endpoint, because
// a report row's executedWorkflowCount is not a run count. An interaction's runs
// land on all its versions, so it is keyed by file.versionControlID (every
// version), never file.id (one version) — counting by file.id misses most runs.
// ---------------------------------------------------------------------------

const NIL_GUID = "00000000-0000-0000-0000-000000000000";
const realId = (v: string | null | undefined): string | undefined =>
  v && v !== NIL_GUID ? v : undefined;

/** The key of an interaction across all its versions: versionControlID, else file.id, else name. */
export function interactionKey(row: ReportRow): string {
  return realId(row.file?.versionControlID) ?? realId(row.file?.id) ?? `name:${row.name ?? "(unnamed)"}`;
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

export interface ReportInteraction {
  key: string;
  name: string;
  type: "test" | "production";
  active: boolean;
  lastActivityDate: string;
}

/** One entry per interaction (rows grouped by interactionKey), most recently active first. */
export function dedupeInteractions(rows: ReportRow[]): ReportInteraction[] {
  const byKey = new Map<string, ReportInteraction>();
  for (const r of rows) {
    const key = interactionKey(r);
    const last = r.lastActivityDate ?? "";
    const prev = byKey.get(key);
    const type = classifyInteractionType(r);
    const active = (r.activeWorkflowCount ?? 0) > 0;
    if (!prev) {
      byKey.set(key, { key, name: r.name ?? "(unnamed)", type, active, lastActivityDate: last });
      continue;
    }
    if (type === "production") prev.type = "production";
    if (active) prev.active = true;
    if (last > prev.lastActivityDate) {
      prev.lastActivityDate = last;
      prev.name = r.name ?? prev.name;
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.lastActivityDate.localeCompare(a.lastActivityDate) || a.name.localeCompare(b.name),
  );
}

export interface PerInteractionCounts {
  /** Runs per interaction key, for the keys whose count call succeeded. */
  counts: Map<string, number>;
  /** Every key was counted (no budget cut-off, no failed call). */
  complete: boolean;
}

/**
 * Count runs for each key (one run-counts call per key) with bounded parallelism.
 * No new call starts once the wall-clock budget is spent; a failed call is skipped.
 * Either leaves `complete` false. countOne/now injected → unit-testable.
 */
export async function countRunsPerInteraction(
  keys: string[],
  countOne: (key: string) => Promise<number>,
  opts?: { concurrency?: number; budgetMs?: number; now?: () => number },
): Promise<PerInteractionCounts> {
  const concurrency = Math.max(1, opts?.concurrency ?? 5);
  const budgetMs = opts?.budgetMs ?? 3_500;
  const now = opts?.now ?? (() => Date.now());
  const start = now();
  const counts = new Map<string, number>();
  let complete = true;
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (next >= keys.length) return;
      if (now() - start >= budgetMs) {
        complete = false;
        return;
      }
      const key = keys[next++]!;
      try {
        counts.set(key, await countOne(key));
      } catch {
        complete = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  return { counts, complete };
}

export interface InteractionRunEntry {
  name: string;
  runs: number;
  type: "test" | "production";
}

export interface ReportDashboard {
  window: { fromDate: string; toDate: string };
  /** Runs in the window, from RPI's run counts. */
  totalRuns: number;
  testRuns: number;
  productionRuns: number;
  /** Interactions with a currently active workflow. */
  activeInteractions: number;
  /** Interactions classified test (donut). */
  testInteractions: number;
  /** Interactions classified production (donut). */
  productionInteractions: number;
  /** Top-N interactions by run count (horizontal bar). */
  runsPerInteraction: InteractionRunEntry[];
  /** Set when runsPerInteraction was ranked from only part of the interactions. */
  runsPerInteractionNote?: string;
  /** The interaction list is partial (too much activity for one report response). */
  truncated: boolean;
  truncationNote?: string;
}

type RunTotals = components["schemas"]["InteractionRunCountsResultsJsonResponseMessage"];

const modeCount = (totals: RunTotals, mode: string): number =>
  totals.executionModes?.find((m) => m?.executionMode === mode)?.resultsCount ?? 0;

/**
 * Assemble the dashboard. Pure: run totals, the deduped interactions and the
 * per-interaction counts are all passed in.
 */
export function summarizeInteractionRuns(input: {
  fromDate: string;
  toDate: string;
  runTotals: RunTotals;
  interactions: ReportInteraction[];
  /** Keys whose runs were requested (the candidate set, most recent first). */
  candidates: string[];
  perInteraction: PerInteractionCounts;
  reportTruncated: boolean;
  topN?: number;
}): ReportDashboard {
  const topN = input.topN ?? 10;
  const { interactions, candidates, perInteraction } = input;
  const byKey = new Map(interactions.map((i) => [i.key, i]));
  const runsPerInteraction = candidates
    .filter((k) => perInteraction.counts.has(k))
    .map((k) => ({ name: byKey.get(k)?.name ?? "(unnamed)", runs: perInteraction.counts.get(k)!, type: byKey.get(k)?.type ?? "test" }))
    .filter((e) => e.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
    .slice(0, topN);
  const ranked = candidates.filter((k) => perInteraction.counts.has(k)).length;
  const exact = !input.reportTruncated && perInteraction.complete && candidates.length === interactions.length;
  return {
    window: { fromDate: input.fromDate, toDate: input.toDate },
    totalRuns: input.runTotals.totalRuns ?? 0,
    testRuns: modeCount(input.runTotals, "Test"),
    productionRuns: modeCount(input.runTotals, "Production"),
    activeInteractions: interactions.filter((i) => i.active).length,
    testInteractions: interactions.filter((i) => i.type === "test").length,
    productionInteractions: interactions.filter((i) => i.type === "production").length,
    runsPerInteraction,
    ...(exact
      ? {}
      : {
          runsPerInteractionNote: `Ranked from the ${ranked} most recently active of ${interactions.length}${input.reportTruncated ? "+" : ""} interactions, so an interaction outside them may have more runs. Tell the user the ranking is partial.`,
        }),
    truncated: input.reportTruncated,
    ...(input.reportTruncated
      ? {
          truncationNote: `This tenant had more interaction activity in the window than one report holds, so the interaction counts and the ranking are PARTIAL (totalRuns is complete). Tell the user and suggest a narrower date range.`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// RUN-COUNTS (RPI 7.8) — server-side counts by time-bucket + execution
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
