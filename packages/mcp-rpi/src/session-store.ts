/**
 * An MCP server's session registry — ownership, idle expiry, caps.
 *
 * A session belongs to the caller that created it: its owner key is a SHA-256 of
 * the caller's token. Any other caller, an unknown id, or a session idle past the
 * TTL all look the same — not found — so session ids cannot be probed. (A token
 * refresh therefore starts a new session; MCP clients re-initialize on 404.)
 *
 * New sessions are capped per owner and globally. At a cap the NEW session is
 * refused; live sessions are never evicted, so no caller can push another out. A
 * slot is reserved before the initialize request runs and released if it produces
 * no session, so concurrent initializes cannot overshoot a cap.
 *
 * The limits are constants of the product, not configuration.
 */
import { createHash } from "crypto";

export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const MAX_SESSIONS = 1000;
export const MAX_SESSIONS_PER_OWNER = 20;

export interface SessionLimits {
  idleTtlMs: number;
  maxSessions: number;
  maxPerOwner: number;
}
export const SESSION_LIMITS: SessionLimits = {
  idleTtlMs: SESSION_IDLE_TTL_MS,
  maxSessions: MAX_SESSIONS,
  maxPerOwner: MAX_SESSIONS_PER_OWNER,
};

/** The owner key for a caller's token (never the token itself). */
export function ownerOf(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex") : "anonymous";
}

interface Closable {
  close(): Promise<void>;
}

export type Reservation<T> = {
  ok: true;
  /** Turn the reserved slot into a live session. */
  commit(sessionId: string, transport: T): void;
  /** Give the slot back (no session came of it). A no-op after commit. */
  release(): void;
};
export type Refusal = { ok: false; status: 429 | 503; message: string };

export class SessionStore<T extends Closable> {
  private readonly live = new Map<string, { transport: T; owner: string; lastSeen: number }>();
  private readonly reservedBy = new Map<string, number>();
  private reservedTotal = 0;

  constructor(
    private readonly limits: SessionLimits = SESSION_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.live.size;
  }

  private liveFor(owner: string): number {
    let n = 0;
    for (const s of this.live.values()) if (s.owner === owner) n++;
    return n;
  }

  /** Reserve a slot for a new session — or refuse it at a cap (never evicting a live one). */
  reserve(owner: string): Reservation<T> | Refusal {
    const mine = this.reservedBy.get(owner) ?? 0;
    if (this.liveFor(owner) + mine >= this.limits.maxPerOwner) {
      return { ok: false, status: 429, message: "Too many open sessions for this caller" };
    }
    if (this.live.size + this.reservedTotal >= this.limits.maxSessions) {
      return { ok: false, status: 503, message: "Session limit reached — try again later" };
    }
    this.reservedBy.set(owner, mine + 1);
    this.reservedTotal++;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      const left = (this.reservedBy.get(owner) ?? 1) - 1;
      if (left > 0) this.reservedBy.set(owner, left);
      else this.reservedBy.delete(owner);
      this.reservedTotal--;
      return true;
    };
    return {
      ok: true,
      commit: (sessionId, transport) => {
        if (settle()) this.live.set(sessionId, { transport, owner, lastSeen: this.now() });
      },
      release: () => void settle(),
    };
  }

  /** The session's transport — only for its owner, and only while not idle past the TTL. */
  get(sessionId: string, owner: string): T | undefined {
    const s = this.live.get(sessionId);
    if (!s || s.owner !== owner) return undefined;
    if (this.now() - s.lastSeen > this.limits.idleTtlMs) {
      this.close(sessionId);
      return undefined;
    }
    s.lastSeen = this.now();
    return s.transport;
  }

  /** Forget a session (its transport closed). */
  remove(sessionId: string): void {
    this.live.delete(sessionId);
  }

  /** Close every session idle past the TTL; returns how many. */
  sweep(): number {
    let n = 0;
    for (const [id, s] of this.live) {
      if (this.now() - s.lastSeen > this.limits.idleTtlMs) {
        this.close(id);
        n++;
      }
    }
    return n;
  }

  private close(sessionId: string): void {
    const s = this.live.get(sessionId);
    this.live.delete(sessionId);
    s?.transport.close().catch(() => {});
  }
}
