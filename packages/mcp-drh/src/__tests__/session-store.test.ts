/**
 * The DRH MCP server's session registry: owner-bound, idle-expiring, capped, never
 * evicting a live session, with reservations that close the initialize race.
 */
import { describe, it, expect } from "bun:test";
import { SessionStore, ownerOf, SESSION_LIMITS } from "../session-store.js";

class FakeTransport {
  closed = false;
  async close() {
    this.closed = true;
  }
}
let t = 0;
const clock = () => t;
const store = (limits = { idleTtlMs: 1000, maxSessions: 3, maxPerOwner: 2 }) => new SessionStore<FakeTransport>(limits, clock);
const open = (s: SessionStore<FakeTransport>, owner: string, id: string) => {
  const r = s.reserve(owner);
  if (!r.ok) throw new Error(r.message);
  const tr = new FakeTransport();
  r.commit(id, tr);
  return tr;
};

describe("SessionStore", () => {
  it("product limits are pinned constants", () => {
    expect(SESSION_LIMITS).toEqual({ idleTtlMs: 30 * 60 * 1000, maxSessions: 1000, maxPerOwner: 20 });
  });
  it("owner key: a hash of the token, never the token", () => {
    expect(ownerOf("tok")).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerOf("tok")).not.toContain("tok");
    expect(ownerOf(undefined)).toBe("anonymous");
  });
  it("only the owner gets its session; a foreign owner and an unknown id look the same (undefined)", () => {
    t = 0;
    const s = store();
    const tr = open(s, "alice", "s1");
    expect(s.get("s1", "alice")).toBe(tr);
    expect(s.get("s1", "bob")).toBeUndefined();
    expect(s.get("nope", "alice")).toBeUndefined();
  });
  it("idle past the TTL → gone and closed; use refreshes the idle clock", () => {
    t = 0;
    const s = store();
    const tr = open(s, "alice", "s1");
    t = 900;
    expect(s.get("s1", "alice")).toBe(tr); // refreshed at 900
    t = 1800;
    expect(s.get("s1", "alice")).toBe(tr); // 900ms idle — still alive
    t = 2801;
    expect(s.get("s1", "alice")).toBeUndefined();
    expect(tr.closed).toBe(true);
    expect(s.size).toBe(0);
  });
  it("caps: per owner → 429, global → 503; the NEW session is refused and live ones stay", () => {
    t = 0;
    const s = store();
    open(s, "alice", "a1");
    open(s, "alice", "a2");
    expect(s.reserve("alice")).toEqual({ ok: false, status: 429, message: "Too many open sessions for this caller" });
    open(s, "bob", "b1");
    expect(s.reserve("carol")).toEqual({ ok: false, status: 503, message: "Session limit reached — try again later" });
    for (const [id, owner] of [["a1", "alice"], ["a2", "alice"], ["b1", "bob"]]) expect(s.get(id!, owner!)).toBeDefined();
  });
  it("reservations count against the caps (concurrent initializes can't overshoot); release gives the slot back", () => {
    t = 0;
    const s = store();
    open(s, "alice", "a1");
    const first = s.reserve("alice");
    expect(first.ok).toBe(true);
    expect(s.reserve("alice").ok).toBe(false); // the in-flight reservation holds the second slot
    if (first.ok) first.release();
    const again = s.reserve("alice");
    expect(again.ok).toBe(true);
    if (again.ok) {
      again.release();
      again.commit("late", new FakeTransport()); // commit after release is a no-op
    }
    expect(s.get("late", "alice")).toBeUndefined();
    expect(s.size).toBe(1);
  });
  it("sweep closes every idle session", () => {
    t = 0;
    const s = store({ idleTtlMs: 1000, maxSessions: 10, maxPerOwner: 10 });
    const a = open(s, "alice", "a1");
    t = 500;
    const b = open(s, "bob", "b1");
    t = 1200;
    expect(s.sweep()).toBe(1);
    expect([a.closed, b.closed]).toEqual([true, false]);
  });
});
