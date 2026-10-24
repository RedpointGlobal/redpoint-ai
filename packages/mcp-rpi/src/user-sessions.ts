/**
 * The per-user session cap, in token mode. ./session-store.ts caps sessions per
 * TOKEN; one user holding many tokens (each refresh is a new one) could still open
 * 20 sessions per token. This caps them per USER — the caller key the auth
 * middleware sets (the token's subject, else a hash of the token) — at the same
 * MAX_SESSIONS_PER_OWNER. Checked before the token cap and the global cap; like
 * them it refuses the NEW session and never evicts a live one. A slot is reserved
 * before the initialize request runs and released if no session comes of it.
 */
import { MAX_SESSIONS_PER_OWNER, type Refusal } from "./session-store.js";

export type UserSlot = {
  ok: true;
  /** The reserved slot became this session. */
  commit(sessionId: string): void;
  /** Give the slot back (no session came of it). A no-op after commit. */
  release(): void;
};

export class UserSessions {
  /** Live + reserved sessions per user. */
  private readonly held = new Map<string, number>();
  private readonly userOf = new Map<string, string>();

  constructor(readonly maxPerUser: number = MAX_SESSIONS_PER_OWNER) {}

  heldBy(user: string): number {
    return this.held.get(user) ?? 0;
  }

  reserve(user: string): UserSlot | Refusal {
    const n = this.heldBy(user);
    if (n >= this.maxPerUser) {
      return { ok: false, status: 429, message: "Too many open sessions for this caller" };
    }
    this.held.set(user, n + 1);
    let settled = false;
    return {
      ok: true,
      commit: (sessionId) => {
        if (settled) return;
        settled = true;
        this.userOf.set(sessionId, user);
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.drop(user);
      },
    };
  }

  /** The session ended (closed, deleted or expired). Idempotent. */
  remove(sessionId: string): void {
    const user = this.userOf.get(sessionId);
    if (user === undefined) return;
    this.userOf.delete(sessionId);
    this.drop(user);
  }

  private drop(user: string): void {
    const left = this.heldBy(user) - 1;
    if (left > 0) this.held.set(user, left);
    else this.held.delete(user);
  }
}
