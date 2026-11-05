/**
 * Data authorization and API-key scoping, auth ON, two users.
 *
 * Two RPI users — alice and bob — are real identities here: a stand-in RPI answers
 * validate-token-status with each one's stable id, exactly as the middleware asks.
 * Every case is one user reaching for the other's data:
 *   - threads (list / get / delete / runs / the agui stream): the owner only; anyone
 *     else, an unowned legacy thread, or the right id under another workspace → 404;
 *   - the trace (it carries tool results): each user reads, follows and clears only
 *     their own events;
 *   - workspace configuration writes (they decide where every user's token goes):
 *     refused (403) to every caller with auth on;
 *   - API keys: only a non-key caller mints; a key acts as its owner; owners list and
 *     revoke only their own; a workspace-scoped key 404s on other workspaces; every
 *     key expires (90 days by default); the old `permissions` field is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../store/schema.js";

const sqlite = new Database(":memory:");
sqlite.run("PRAGMA foreign_keys = ON");
for (const ddl of [
  `CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, config TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE threads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_results TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', error TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER)`,
  `CREATE TABLE api_keys (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, name TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id), permissions TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER)`,
  `CREATE TABLE thread_owners (thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, user_id TEXT NOT NULL)`,
  `CREATE TABLE api_key_owners (key_id TEXT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE, user_id TEXT NOT NULL)`,
]) sqlite.run(ddl);
const testDb = drizzle(sqlite, { schema });
mock.module("../store/db.js", () => ({ db: testDb }));

// A stand-in RPI: validate-token-status answers each user's stable id.
const IDS: Record<string, string> = { "tok-alice": "aaaaaaaa-0000-0000-0000-00000000000a", "tok-bob": "bbbbbbbb-0000-0000-0000-00000000000b" };
const rpi = Bun.serve({
  port: 0,
  fetch(req) {
    const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    return IDS[tok] ? Response.json({ id: IDS[tok] }) : new Response("no", { status: 401 });
  },
});
process.env.RPI_INTEGRATION_API_URL = `http://127.0.0.1:${rpi.port}`;
process.env.AUTH_REQUIRED = "true";

const { Hono } = await import("hono");
const { authMiddleware } = await import("../middleware/auth.js");
const { workspaceRoutes } = await import("../routes/workspaces.js");
const { threadRoutes } = await import("../routes/threads.js");
const { aguiRoutes } = await import("../routes/agui.js");
const { authRoutes } = await import("../routes/auth.js");
const { appendTrace } = await import("../lib/trace-buffer.js");

const app = new Hono();
app.use("/api/v1/*", authMiddleware);
app.route("/api/v1/workspaces", workspaceRoutes);
app.route("/api/v1/workspaces/:workspaceId/threads", threadRoutes);
app.route("/api/v1/workspaces", aguiRoutes);
app.route("/api/v1/auth", authRoutes);

const ALICE = `rpi:${IDS["tok-alice"]}`;
const as = (who: "alice" | "bob") => ({ "X-RPI-Token": `tok-${who}`, "Content-Type": "application/json" });
const key = (k: string) => ({ Authorization: `Bearer ${k}`, "Content-Type": "application/json" });
const req = (path: string, headers: Record<string, string>, init: RequestInit = {}) => app.request(`http://x/api/v1${path}`, { ...init, headers });

const WS1 = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
beforeAll(() => {
  const now = Date.now();
  for (const id of [WS1, WS2]) sqlite.run("INSERT INTO workspaces VALUES (?,?,?,?,?,?)", [id, `ws-${id.slice(0, 1)}`, null, "{}", now, now]);
});
afterAll(() => rpi.stop(true));

const aliceThread = async (ws = WS1) => (await (await req(`/workspaces/${ws}/threads`, as("alice"), { method: "POST", body: JSON.stringify({ title: "alice's" }) })).json()) as { id: string };

describe("B3 — threads belong to their creator", () => {
  it("the owner sees, reads, runs and lists their thread", async () => {
    const t = await aliceThread();
    expect((await req(`/workspaces/${WS1}/threads/${t.id}`, as("alice"))).status).toBe(200);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}/runs`, as("alice"), { method: "POST", body: JSON.stringify({ message: "hi" }) })).status).toBe(201);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}/runs`, as("alice"))).status).toBe(200);
    const list = (await (await req(`/workspaces/${WS1}/threads`, as("alice"))).json()) as Array<{ id: string }>;
    expect(list.map((x) => x.id)).toContain(t.id);
  });

  it("another user: not in their list; get / delete / runs (create + list) / the agui stream → 404", async () => {
    const t = await aliceThread();
    const list = (await (await req(`/workspaces/${WS1}/threads`, as("bob"))).json()) as Array<{ id: string }>;
    expect(list.map((x) => x.id)).not.toContain(t.id);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}`, as("bob"))).status).toBe(404);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}/runs`, as("bob"), { method: "POST", body: JSON.stringify({ message: "x" }) })).status).toBe(404);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}/runs`, as("bob"))).status).toBe(404);
    const agui = await req(`/workspaces/${WS1}/threads/${t.id}/runs/r1/stream`, as("bob"), { method: "POST", body: "{}" });
    expect([agui.status, await agui.json()]).toEqual([404, { error: "Thread not found" }]);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}`, as("bob"), { method: "DELETE" })).status).toBe(404);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}`, as("alice"))).status).toBe(200); // still there
  });

  it("the owner's own thread under ANOTHER workspace's id → 404 (no cross-workspace reach)", async () => {
    const t = await aliceThread(WS1);
    expect((await req(`/workspaces/${WS2}/threads/${t.id}`, as("alice"))).status).toBe(404);
  });

  it("an unowned (pre-7.179) thread is invisible to every authenticated caller", async () => {
    const now = Date.now();
    sqlite.run("INSERT INTO threads VALUES (?,?,?,?,?)", ["legacy-thread", WS1, "old", now, now]);
    for (const who of ["alice", "bob"] as const) {
      expect((await req(`/workspaces/${WS1}/threads/legacy-thread`, as(who))).status).toBe(404);
      const list = (await (await req(`/workspaces/${WS1}/threads`, as(who))).json()) as Array<{ id: string }>;
      expect(list.map((x) => x.id)).not.toContain("legacy-thread");
    }
  });
});

describe("B3 — the trace is per user", () => {
  const ev = (m: string) => ({ timestamp: new Date().toISOString(), direction: "FromMCP" as const, type: "tool-result" as const, message: m, result: { secret: m } });

  it("each user reads only their own events; another's clear doesn't touch them", async () => {
    appendTrace(WS1, ALICE, ev("alice's audiences"));
    const bob = (await (await req(`/workspaces/${WS1}/trace`, as("bob"))).json()) as unknown[];
    expect(bob).toEqual([]);
    expect((await req(`/workspaces/${WS1}/trace?clear=1`, as("bob"))).status).toBe(200);
    const alice = (await (await req(`/workspaces/${WS1}/trace`, as("alice"))).json()) as Array<{ message: string }>;
    expect(alice.map((e) => e.message)).toEqual(["alice's audiences"]);
  });

  it("the live stream replays and follows the caller's own events only", async () => {
    appendTrace(WS2, ALICE, ev("alice-before"));
    const res = await req(`/workspaces/${WS2}/trace/stream`, as("bob"));
    const reader = res.body!.getReader();
    appendTrace(WS2, ALICE, ev("alice-after"));
    appendTrace(WS2, `rpi:${IDS["tok-bob"]}`, ev("bob-own"));
    let seen = "";
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !seen.includes("bob-own")) {
      const r = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: false }), 300))]);
      if (r.value) seen += new TextDecoder().decode(r.value);
    }
    await reader.cancel();
    expect(seen).toContain("bob-own");
    expect(seen).not.toContain("alice-before");
    expect(seen).not.toContain("alice-after");
  });
});

describe("B3 / B1 / B2 — workspace configuration writes are refused with auth on", () => {
  const body = JSON.stringify({ name: "evil", provider: { type: "openai", model: "x" }, mcp: [{ name: "rpi", transport: "http", url: "http://attacker.example/mcp" }] });
  it("create / update / delete → 403 for an RPI user and for an API key", async () => {
    const minted = (await (await req("/auth/api-keys", as("alice"), { method: "POST", body: JSON.stringify({ name: "k" }) })).json()) as { key: string };
    for (const h of [as("alice"), key(minted.key)]) {
      expect((await req("/workspaces", h, { method: "POST", body })).status).toBe(403);
      expect((await req(`/workspaces/${WS1}`, h, { method: "PUT", body })).status).toBe(403);
      expect((await req(`/workspaces/${WS1}`, h, { method: "DELETE" })).status).toBe(403);
    }
    const row = sqlite.query("SELECT config FROM workspaces WHERE id = ?").get(WS1) as { config: string };
    expect(row.config).toBe("{}"); // untouched
  });
});

describe("B4 — API keys", () => {
  const mint = async (h: Record<string, string>, extra: Record<string, unknown> = {}) => req("/auth/api-keys", h, { method: "POST", body: JSON.stringify({ name: "k", ...extra }) });

  it("a key acts AS its owner: it reaches its owner's thread, not another user's", async () => {
    const t = await aliceThread();
    const ak = ((await (await mint(as("alice"))).json()) as { key: string }).key;
    const bk = ((await (await mint(as("bob"))).json()) as { key: string }).key;
    expect((await req(`/workspaces/${WS1}/threads/${t.id}`, key(ak))).status).toBe(200);
    expect((await req(`/workspaces/${WS1}/threads/${t.id}`, key(bk))).status).toBe(404);
  });

  it("a key can't mint a key (403)", async () => {
    const ak = ((await (await mint(as("alice"))).json()) as { key: string }).key;
    expect((await mint(key(ak))).status).toBe(403);
  });

  it("owners list and revoke only their own keys; another's id → 404", async () => {
    const a = (await (await mint(as("alice"))).json()) as { id: string };
    const bobList = (await (await req("/auth/api-keys", as("bob"))).json()) as Array<{ id: string }>;
    expect(bobList.map((k) => k.id)).not.toContain(a.id);
    expect((await req(`/auth/api-keys/${a.id}`, as("bob"), { method: "DELETE" })).status).toBe(404);
    const aliceList = (await (await req("/auth/api-keys", as("alice"))).json()) as Array<{ id: string }>;
    expect(aliceList.map((k) => k.id)).toContain(a.id);
    expect((await req(`/auth/api-keys/${a.id}`, as("alice"), { method: "DELETE" })).status).toBe(200);
  });

  it("a workspace-scoped key reaches its workspace only (others 404; the list shows its own)", async () => {
    const k = ((await (await mint(as("alice"), { workspaceId: WS1 })).json()) as { key: string }).key;
    expect((await req(`/workspaces/${WS1}/trace`, key(k))).status).toBe(200);
    expect((await req(`/workspaces/${WS2}/trace`, key(k))).status).toBe(404);
    expect((await req(`/workspaces/${WS2}/threads`, key(k))).status).toBe(404);
    const list = (await (await req("/workspaces", key(k))).json()) as Array<{ id: string }>;
    expect(list.map((w) => w.id)).toEqual([WS1]);
  });

  it("every key expires: 90 days by default; an expired key → 401", async () => {
    const res = (await (await mint(as("alice"))).json()) as { id: string; key: string; expiresAt: string };
    const days = (Date.parse(res.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    sqlite.run("UPDATE api_keys SET expires_at = ? WHERE id = ?", [Math.floor((Date.now() - 1000) / 1000), res.id]);
    expect((await req("/workspaces", key(res.key))).status).toBe(401);
  });

  it("the unenforced `permissions` field is refused; 365 days is the most", async () => {
    expect((await mint(as("alice"), { permissions: ["admin"] })).status).toBe(400);
    expect((await mint(as("alice"), { expiresInDays: 366 })).status).toBe(400);
  });
});
