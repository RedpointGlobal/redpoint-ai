/**
 * The app server's own budgets, on top of the mirrored ones (./rate-limit.ts,
 * ./validation-guard.ts). Keyed on the AUTHENTICATED caller (auth/caller.ts): behind
 * the web proxy every browser request comes from one address, so the per-user
 * budgets are the ones that separate users.
 *
 *   - requests per user:          MAX_REQUESTS_PER_USER (120) a minute, every /api/v1 call;
 *   - chat turns per user:        MAX_TURNS_PER_USER (20) a minute — a turn is the
 *                                 expensive call (LLM tokens + many RPI tool calls):
 *                                 the chat route, the AG-UI stream, an A2A message;
 *   - trace streams per user:     MAX_TRACE_STREAMS_PER_USER (5) open at once;
 *   - API keys minted per user:   MAX_KEY_MINTS_PER_HOUR (10) an hour.
 *
 * DEV MODE (auth off, AUTH_REQUIRED=false): one local operator with no authenticated
 * identity to key on, so none of these apply — the local run stays fully usable
 * (like the config-write and thread-ownership carve-outs). The per-peer flood ceiling
 * and the global validation budget stay on everywhere; one local user never meets them.
 * Over a budget → 429 + Retry-After. The limits are constants of the product.
 */
import { createMiddleware } from "hono/factory";
import { WindowBudget, tooManyRequests, type RateLimiter } from "./rate-limit.js";
import { callerId, isDevMode } from "../auth/caller.js";

export const MAX_TURNS_PER_USER = 20;
export const MAX_TRACE_STREAMS_PER_USER = 5;
export const MAX_KEY_MINTS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
const MAX_TRACKED_USERS = 10_000;

/** After auth: each caller's request budget (off in dev mode). */
export function userRequestLimit(limiter: RateLimiter) {
  return createMiddleware(async (c, next) => {
    if (!isDevMode()) {
      const admission = limiter.userRequests.take(callerId(c));
      if (!admission.ok) return tooManyRequests(c, admission.retryAfterSec);
    }
    await next();
  });
}

/** Chat turns per user per minute — shared by the chat route, the AG-UI stream and A2A. */
export const turnBudget = new WindowBudget(MAX_TURNS_PER_USER);

/** Before a turn: the caller's turn budget (off in dev mode). */
export function turnLimit(budget: WindowBudget = turnBudget) {
  return createMiddleware(async (c, next) => {
    if (!isDevMode()) {
      const admission = budget.take(callerId(c));
      if (!admission.ok) return tooManyRequests(c, admission.retryAfterSec);
    }
    await next();
  });
}

/** Open trace streams per user. */
export class StreamSlots {
  private readonly open = new Map<string, number>();
  constructor(readonly limit: number = MAX_TRACE_STREAMS_PER_USER) {}
  /** A slot for `user`, or null at the cap. Release it when the stream ends. */
  acquire(user: string): (() => void) | null {
    if (isDevMode()) return () => {};
    const n = this.open.get(user) ?? 0;
    if (n >= this.limit) return null;
    this.open.set(user, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(user) ?? 1) - 1;
      if (left <= 0) this.open.delete(user);
      else this.open.set(user, left);
    };
  }
  count(user: string): number {
    return this.open.get(user) ?? 0;
  }
}
export const traceStreams = new StreamSlots();

/** API keys minted per user per hour (a fixed hourly window, bounded tracking). */
export class HourlyBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    readonly limit: number = MAX_KEY_MINTS_PER_HOUR,
    private readonly now: () => number = Date.now,
  ) {}
  /** Count one if allowed; else the seconds until the window resets. */
  take(user: string): { ok: true } | { ok: false; retryAfterSec: number } {
    if (isDevMode()) return { ok: true };
    const t = this.now();
    let w = this.windows.get(user);
    if (!w || t - w.start >= HOUR_MS) {
      this.windows.delete(user);
      w = { start: t, count: 0 };
      this.windows.set(user, w);
      for (const k of this.windows.keys()) {
        if (this.windows.size <= MAX_TRACKED_USERS) break;
        this.windows.delete(k);
      }
    }
    if (w.count >= this.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + HOUR_MS - t) / 1000)) };
    w.count++;
    return { ok: true };
  }
}
export const keyMints = new HourlyBudget();
