/**
 * MIRROR of packages/mcp-rpi/src/validation-guard.ts (the RPI MCP server, in this
 * repo) — keep in sync; __tests__/limits-sync.test.ts holds the code identical below
 * this header.
 *
 * What a presented RPI token may cost RPI: every token not answered from the
 * validation cache is checked by RPI's validate-token-status (../auth/rpi-token-check.ts),
 * so a caller inventing tokens would turn this server into an unmetered relay against
 * RPI. Two budgets, applied only before a NEW remote validation: failures per key
 * (the app server keys it per TOKEN — behind the web proxy every browser request
 * shares one address, so an address budget would let one user lock out everyone)
 * and MAX_REMOTE_VALIDATIONS for the whole server (the real ceiling on what RPI can
 * be asked). Over either → 429 without calling RPI; cached tokens still get in.
 */
import type { Context } from "hono";
import {
  WindowBudget,
  clientKey,
  MAX_AUTH_FAILURES_PER_PEER,
  MAX_TRACKED_CLIENTS,
  RATE_WINDOW_MS,
} from "./rate-limit.js";
import type { TokenCheck } from "../auth/rpi-token-check.js";

export const MAX_REMOTE_VALIDATIONS = 600;

export type ValidationAdmission =
  | { ok: true; settle(result: TokenCheck["result"]): void }
  | { ok: false; retryAfterSec: number };

export class ValidationGuard {
  readonly remoteValidations: WindowBudget;
  /** Per address: failures this window, and validations waiting on RPI. */
  private readonly peers = new Map<string, { start: number; failures: number; pending: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly keyOf: (c: Context) => string = clientKey,
  ) {
    this.remoteValidations = new WindowBudget(MAX_REMOTE_VALIDATIONS, now);
  }

  private peer(key: string): { start: number; failures: number; pending: number } {
    const t = this.now();
    let p = this.peers.get(key);
    if (!p) {
      p = { start: t, failures: 0, pending: 0 };
      this.peers.set(key, p);
      // Bounded: drop the oldest addresses with nothing pending.
      for (const [k, v] of this.peers) {
        if (this.peers.size <= MAX_TRACKED_CLIENTS) break;
        if (v.pending === 0) this.peers.delete(k);
      }
    } else if (t - p.start >= RATE_WINDOW_MS) {
      p.start = t;
      p.failures = 0;
    }
    return p;
  }

  /** Before a new remote validation: the address's failure budget, then the server's. */
  admit(c: Context): ValidationAdmission {
    const p = this.peer(this.keyOf(c));
    if (p.failures >= MAX_AUTH_FAILURES_PER_PEER) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((p.start + RATE_WINDOW_MS - this.now()) / 1000)) };
    }
    // Under the budget only because answers are still pending: retry shortly.
    if (p.failures + p.pending >= MAX_AUTH_FAILURES_PER_PEER) return { ok: false, retryAfterSec: 1 };
    const server = this.remoteValidations.take("server");
    if (!server.ok) return server;
    p.pending++;
    let settled = false;
    return {
      ok: true,
      settle: (result) => {
        if (settled) return;
        settled = true;
        p.pending--;
        if (result === "invalid") this.failure(p);
      },
    };
  }

  /** A presented token failed without a new remote validation (a cached or shared answer). */
  failed(c: Context): void {
    this.failure(this.peer(this.keyOf(c)));
  }

  private failure(p: { start: number; failures: number }): void {
    if (this.now() - p.start >= RATE_WINDOW_MS) {
      p.start = this.now();
      p.failures = 0;
    }
    p.failures++;
  }
}
