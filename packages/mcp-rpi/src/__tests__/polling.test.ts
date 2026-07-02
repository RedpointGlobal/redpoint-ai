import { describe, it, expect } from "bun:test";
import {
  pollUntilTerminal,
  PollingTimeoutError,
  JobFailedError,
  NotStartedError,
} from "../client/polling.js";

/**
 * Fake clock + fake sleep so tests run instantly. `sleep(ms)` advances the
 * clock by `ms` and resolves synchronously on the microtask queue.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe("pollUntilTerminal", () => {
  it("resolves when the status becomes 'completed'", async () => {
    const clock = fakeClock();
    const statuses = ["Executing", "Executing", "Completed"];
    let i = 0;
    const result = await pollUntilTerminal(
      async () => statuses[i++]!,
      {
        isTerminal: (s) =>
          s === "Completed" ? "completed" : s === "Failed" ? "failed" : "pending",
        intervalMs: 100,
        timeoutMs: 10_000,
        ...clock,
      },
    );
    expect(result).toBe("Completed");
    expect(i).toBe(3);
  });

  it("throws JobFailedError on 'failed' and attaches the status", async () => {
    const clock = fakeClock();
    const statuses = ["Executing", "Failed"];
    let i = 0;
    await expect(
      pollUntilTerminal(async () => ({ status: statuses[i++]!, err: "boom" }), {
        isTerminal: (s) =>
          s.status === "Completed"
            ? "completed"
            : s.status === "Failed"
              ? "failed"
              : "pending",
        failureReason: (s) => s.err,
        intervalMs: 100,
        timeoutMs: 10_000,
        ...clock,
      }),
    ).rejects.toMatchObject({
      name: "JobFailedError",
      message: "Job failed: boom",
    });
  });

  it("throws PollingTimeoutError when the deadline is reached", async () => {
    const clock = fakeClock();
    const err = await pollUntilTerminal(async () => "Executing", {
      isTerminal: () => "pending",
      intervalMs: 1000,
      timeoutMs: 3000,
      ...clock,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PollingTimeoutError);
    expect((err as PollingTimeoutError).lastStatus).toBe("Executing");
  });

  it("throws NotStartedError once the grace window has elapsed", async () => {
    const clock = fakeClock();
    const err = await pollUntilTerminal(async () => "NotStarted", {
      isTerminal: () => "pending",
      isNotStarted: (s) => s === "NotStarted",
      intervalMs: 1000,
      timeoutMs: 10 * 60 * 1000,
      notStartedGraceMs: 5000,
      ...clock,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NotStartedError);
  });

  it("does not apply the NotStarted check before the grace window expires", async () => {
    const clock = fakeClock();
    const statuses = ["NotStarted", "NotStarted", "Executing", "Completed"];
    let i = 0;
    const result = await pollUntilTerminal(
      async () => statuses[i++]!,
      {
        isTerminal: (s) =>
          s === "Completed" ? "completed" : s === "Failed" ? "failed" : "pending",
        isNotStarted: (s) => s === "NotStarted",
        intervalMs: 1000,
        notStartedGraceMs: 10_000,
        timeoutMs: 60_000,
        ...clock,
      },
    );
    expect(result).toBe("Completed");
  });

  it("propagates errors thrown by fetchStatus", async () => {
    const clock = fakeClock();
    await expect(
      pollUntilTerminal(
        async () => {
          throw new Error("network blew up");
        },
        {
          isTerminal: () => "pending",
          intervalMs: 100,
          timeoutMs: 1000,
          ...clock,
        },
      ),
    ).rejects.toThrow("network blew up");
  });
});
