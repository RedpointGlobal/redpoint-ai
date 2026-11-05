/**
 * MIRROR of packages/mcp-rpi/src/rate-limit.ts (the RPI MCP server, in this repo) —
 * keep in sync; the sync test (__tests__/limits-sync.test.ts) holds the code
 * identical below this header. The MCP server is a standalone binary with no shared
 * package, so the proven budgets are mirrored, not imported.
 *
 * Fixed-window budgets: a WindowBudget is `limit` events per key per minute, with
 * bounded key tracking (MAX_TRACKED_CLIENTS, oldest dropped). The app server uses the
 * per-peer flood ceiling (before auth) and the per-user request budget (after auth);
 * its own turn / stream / mint budgets are in ./web-limits.ts. Over a budget → 429 +
 * Retry-After. The limits are constants of the product, not configuration.
 */
import { createMiddleware } from "hono/factory";
import { getConnInfo } from "hono/bun";
import type { Context } from "hono";

export const RATE_WINDOW_MS = 60_000;
export const MAX_REQUESTS_PER_USER = 120;
export const MAX_REQUESTS_PER_PEER = 10 * MAX_REQUESTS_PER_USER;
export const MAX_AUTH_FAILURES_PER_PEER = 10;
export const MAX_TRACKED_CLIENTS = 10_000;

export type Admission = { ok: true } | { ok: false; retryAfterSec: number };

/** One fixed-window budget: `limit` events per key per window, bounded key tracking. */
export class WindowBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  private windowFor(key: string): { start: number; count: number } {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= RATE_WINDOW_MS) {
      this.windows.delete(key); // re-insert → newest
      w = { start: t, count: 0 };
      this.windows.set(key, w);
      for (const k of this.windows.keys()) {
        if (this.windows.size <= MAX_TRACKED_CLIENTS) break;
        this.windows.delete(k);
      }
    }
    return w;
  }

  private refusal(w: { start: number }): Admission {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + RATE_WINDOW_MS - this.now()) / 1000)) };
  }

  /** Count one event if the budget allows it; refuse (not counting) once it is spent. */
  take(key: string): Admission {
    const w = this.windowFor(key);
    if (w.count >= this.limit) return this.refusal(w);
    w.count++;
    return { ok: true };
  }

  /** Count one event unconditionally. */
  record(key: string): void {
    this.windowFor(key).count++;
  }

  /** Spent for this window? → the refusal to answer with; otherwise ok. */
  check(key: string): Admission {
    const w = this.windowFor(key);
    return w.count >= this.limit ? this.refusal(w) : { ok: true };
  }

  get trackedKeys(): number {
    return this.windows.size;
  }
}

/** The three budgets: per-peer requests, per-peer auth failures, per-user requests. */
export class RateLimiter {
  readonly peerRequests: WindowBudget;
  readonly peerAuthFailures: WindowBudget;
  readonly userRequests: WindowBudget;
  constructor(now: () => number = Date.now) {
    this.peerRequests = new WindowBudget(MAX_REQUESTS_PER_PEER, now);
    this.peerAuthFailures = new WindowBudget(MAX_AUTH_FAILURES_PER_PEER, now);
    this.userRequests = new WindowBudget(MAX_REQUESTS_PER_USER, now);
  }
}

/** The client's address — the TCP peer; "unknown" when not served by Bun (in-process tests). */
export function clientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The 429 every budget answers with. */
export function tooManyRequests(c: Context, retryAfterSec: number): Response {
  c.header("Retry-After", String(retryAfterSec));
  return c.json({ error: "Too many requests — retry later" }, 429);
}

/** Before auth: the per-address flood ceiling. */
export function peerFloodLimit(limiter: RateLimiter, keyOf: (c: Context) => string = clientKey) {
  return createMiddleware(async (c, next) => {
    const admission = limiter.peerRequests.take(keyOf(c));
    if (!admission.ok) return tooManyRequests(c, admission.retryAfterSec);
    await next();
  });
}

/** After auth: the per-user budget, keyed by the verified caller (`userKeyOf`). */
export function userLimit(limiter: RateLimiter, userKeyOf: (c: Context) => string) {
  return createMiddleware(async (c, next) => {
    const admission = limiter.userRequests.take(userKeyOf(c));
    if (!admission.ok) return tooManyRequests(c, admission.retryAfterSec);
    await next();
  });
}
