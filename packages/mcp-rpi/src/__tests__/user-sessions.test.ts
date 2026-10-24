/**
 * The per-user session cap (../user-sessions.ts): the NEW session is refused at
 * the cap, live ones are never evicted, reservations count, and an ended session
 * frees its slot exactly once.
 */
import { describe, expect, it } from "bun:test";
import { UserSessions } from "../user-sessions.js";
import { MAX_SESSIONS_PER_OWNER } from "../session-store.js";

describe("UserSessions", () => {
  it(`caps each user at ${MAX_SESSIONS_PER_OWNER} (live + reserved); another user is unaffected`, () => {
    const u = new UserSessions();
    for (let i = 0; i < MAX_SESSIONS_PER_OWNER; i++) {
      const slot = u.reserve("alice");
      expect(slot.ok).toBe(true);
      if (slot.ok && i % 2 === 0) slot.commit(`s-${i}`); // half live, half still reserved
    }
    expect(u.reserve("alice")).toEqual({ ok: false, status: 429, message: "Too many open sessions for this caller" });
    expect(u.reserve("bob").ok).toBe(true);
  });

  it("release gives an uncommitted slot back; release after commit is a no-op", () => {
    const u = new UserSessions(1);
    const a = u.reserve("alice");
    if (a.ok) a.release();
    const b = u.reserve("alice");
    expect(b.ok).toBe(true);
    if (b.ok) {
      b.commit("s1");
      b.release();
    }
    expect(u.reserve("alice").ok).toBe(false);
  });

  it("remove frees the slot once (closed + deleted for one session counts once)", () => {
    const u = new UserSessions(2);
    for (const id of ["s1", "s2"]) {
      const slot = u.reserve("alice");
      if (slot.ok) slot.commit(id);
    }
    u.remove("s1");
    u.remove("s1");
    u.remove("unknown");
    expect(u.heldBy("alice")).toBe(1);
    expect(u.reserve("alice").ok).toBe(true);
    expect(u.reserve("alice").ok).toBe(false);
  });
});
