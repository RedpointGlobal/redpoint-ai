/**
 * Reactive 429 backoff at the fetch layer — the deployment's 429 IS the probe.
 *
 * On a tight Azure tier a single agent turn (parent + sub-agent) draws more than
 * the per-minute window holds at one instant, so a call 429s. The 429 carries a
 * real `retry-after` (seconds) = when the bucket has refilled enough. We wait
 * EXACTLY that, then refire — no separate proactive probe (which would burn the
 * bucket and renew the window), no arbitrary threshold or sleep.
 *
 * Why not just bump `maxRetries`: Azure also sends `retry-after-ms: 0`, which the
 * AI SDK's built-in retry prefers, so it refires immediately 3× (all 429) and
 * gives up in ~14s — measured. This wrapper ignores the misleading `-ms: 0` and
 * honors the real `retry-after`, so the refire lands after the bucket recovers.
 *
 * No-op for non-429 responses; bounded by a total budget so a genuinely stuck
 * deployment fails in bounded time instead of hanging the user.
 */

const MAX_TOTAL_MS = 75_000; // a couple of retry-after cycles, then surface the 429

function retryAfterSeconds(res: Response): number {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return ra;
  const reset = res.headers.get("x-ratelimit-reset-tokens");
  if (reset) {
    const n = Number(reset.replace(/[a-zA-Z]+$/, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5;
}

/** Wrap fetch so a 429 waits the server's reported `retry-after`, then refires. */
export function createRetryAfterFetch(base: typeof fetch = fetch): typeof fetch {
  // The wrapper only ever *calls* fetch (never `.preconnect`), so the structural
  // arrow doesn't carry fetch's `preconnect` member — cast to typeof fetch.
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const start = Date.now();
    let res = await base(input, init);
    while (res.status === 429 && Date.now() - start < MAX_TOTAL_MS) {
      const waitMs = retryAfterSeconds(res) * 1000;
      if (Date.now() - start + waitMs > MAX_TOTAL_MS) break; // would blow the budget — surface the 429
      console.log(`[retry-after] 429 → waiting ${waitMs}ms (deployment-reported), then refiring`);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await base(input, init);
    }
    return res;
  };
  return wrapped as typeof fetch;
}
