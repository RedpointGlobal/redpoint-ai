/**
 * Generic start+wait+fetch helper for RPI's polling-based async pattern.
 *
 * Matches the Java RPI-MCPServer `AudienceClient.waitForCountToComplete`
 * defaults: 1s poll interval, 5-minute total timeout, and an early-fail at
 * 60s if the status is still "not started". Behavior is configurable per
 * call via `PollOptions`.
 */

export type TerminalKind = "completed" | "failed" | "pending";

export interface PollOptions<T> {
  /** Classify the current status: "completed" to resolve, "failed" to throw. */
  isTerminal: (status: T) => TerminalKind;
  /** True while the job has not yet begun executing. Triggers the early-fail check. */
  isNotStarted?: (status: T) => boolean;
  /** Extract a human-readable error message on failure. */
  failureReason?: (status: T) => string | undefined;
  /** ms between polls (default 1000). */
  intervalMs?: number;
  /** Overall deadline in ms (default 300_000 = 5 minutes). */
  timeoutMs?: number;
  /** Grace window in ms before failing if still isNotStarted (default 60_000). */
  notStartedGraceMs?: number;
  /** Injected clock — tests pass a fake Date.now(). */
  now?: () => number;
  /** Injected sleep — tests pass a fake setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class PollingTimeoutError extends Error {
  readonly lastStatus: unknown;
  constructor(timeoutMs: number, lastStatus: unknown) {
    super(`Polling timed out after ${timeoutMs}ms`);
    this.name = "PollingTimeoutError";
    this.lastStatus = lastStatus;
  }
}

export class JobFailedError extends Error {
  readonly status: unknown;
  constructor(reason: string | undefined, status: unknown) {
    super(reason ? `Job failed: ${reason}` : "Job failed");
    this.name = "JobFailedError";
    this.status = status;
  }
}

export class NotStartedError extends Error {
  readonly lastStatus: unknown;
  constructor(graceMs: number, lastStatus: unknown) {
    super(`Job did not start within ${graceMs}ms`);
    this.name = "NotStartedError";
    this.lastStatus = lastStatus;
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `fetchStatus` until it returns a terminal status or the deadline passes.
 *
 * Resolves with the final status on `completed`. Throws `JobFailedError` on
 * `failed`, `NotStartedError` if still in `isNotStarted` after the grace
 * window, and `PollingTimeoutError` on overall timeout.
 */
export async function pollUntilTerminal<T>(
  fetchStatus: () => Promise<T>,
  opts: PollOptions<T>,
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const notStartedGraceMs = opts.notStartedGraceMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const start = now();
  let lastStatus: T | undefined;

  while (now() - start < timeoutMs) {
    await sleep(intervalMs);
    const status = await fetchStatus();
    lastStatus = status;

    const kind = opts.isTerminal(status);
    if (kind === "completed") return status;
    if (kind === "failed") {
      throw new JobFailedError(opts.failureReason?.(status), status);
    }

    if (
      opts.isNotStarted?.(status) &&
      now() - start > notStartedGraceMs
    ) {
      throw new NotStartedError(notStartedGraceMs, status);
    }
  }

  throw new PollingTimeoutError(timeoutMs, lastStatus);
}
