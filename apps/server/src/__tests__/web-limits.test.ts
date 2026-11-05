/**
 * The app server's bounds, with the real auth middleware and a stand-in
 * RPI (validate-token-status) that counts its calls:
 *   - per-user requests (120/min), chat turns (20/min), trace streams (5 open),
 *     API-key mints (10/hour) → the next one 429 + Retry-After;
 *   - the global remote-validation budget: spent → a NEW token is refused (429)
 *     WITHOUT calling RPI, while a cached valid user still gets in;
 *   - the A2A turn budget; the runtime-status cache bound;
 *   - index.ts wires them in the right order, caps the body and pins SERVE_MODE;
 *   - DEV MODE (auth off): none of the per-user budgets throttle the local user.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../store/schema.js";

const sqlite = new Database(":memory:");
for (const ddl of [
  `CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, config TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE threads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE api_keys (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, name TEXT NOT NULL, workspace_id TEXT, permissions TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER)`,
  `CREATE TABLE thread_owners (thread_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)`,
  `CREATE TABLE api_key_owners (key_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)`,
]) sqlite.run(ddl);
mock.module("../store/db.js", () => ({ db: drizzle(sqlite, { schema }) }));

let rpiCalls = 0;
const rpi = Bun.serve({
  port: 0,
  fetch(req) {
    rpiCalls++;
    const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    return tok.startsWith("tok-") ? Response.json({ id: `0000000${tok.length}-0000-0000-0000-${tok.slice(4).padStart(12, "0")}` }) : new Response("no", { status: 401 });
  },
});
process.env.RPI_INTEGRATION_API_URL = `http://127.0.0.1:${rpi.port}`;
process.env.AUTH_REQUIRED = "true";

const { Hono } = await import("hono");
const { authMiddleware, rpiValidationGuard } = await import("../middleware/auth.js");
const { RateLimiter, MAX_REQUESTS_PER_USER } = await import("../lib/rate-limit.js");
const { MAX_REMOTE_VALIDATIONS } = await import("../lib/validation-guard.js");
const { userRequestLimit, turnLimit, MAX_TURNS_PER_USER, MAX_TRACE_STREAMS_PER_USER, MAX_KEY_MINTS_PER_HOUR, StreamSlots, HourlyBudget } = await import("../lib/web-limits.js");
const { workspaceRoutes, boundRuntimeStatusCache, runtimeStatusCacheSize, primeRuntimeStatusCache, MAX_RUNTIME_STATUS_ENTRIES } = await import("../routes/workspaces.js");
const { authRoutes } = await import("../routes/auth.js");
const { a2aTurnLimit } = await import("../a2a/server.js");

/** The app, wired as index.ts wires it (a turn route stands in for the chat route). */
const build = () => {
  const app = new Hono();
  const limiter = new RateLimiter();
  app.use("/api/v1/*", authMiddleware);
  app.use("/api/v1/*", userRequestLimit(limiter));
  app.on("POST", "/api/v1/workspaces/:workspaceId/chat", turnLimit(), (c) => c.json({ turn: true }));
  app.route("/api/v1/workspaces", workspaceRoutes);
  app.route("/api/v1/auth", authRoutes);
  return app;
};
const as = (who: string) => ({ "X-RPI-Token": `tok-${who}`, "Content-Type": "application/json" });
const WS = "11111111-1111-4111-8111-111111111111";
beforeAll(() => {
  sqlite.run("INSERT INTO workspaces VALUES (?,?,?,?,?,?)", [WS, "ws", null, "{}", Date.now(), Date.now()]);
});
afterAll(() => {
  rpi.stop(true);
  process.env.AUTH_REQUIRED = "true";
});

describe("per-user budgets (auth on)", () => {
  it(`requests: the ${MAX_REQUESTS_PER_USER + 1}th in a minute → 429 + Retry-After; another user is unaffected`, async () => {
    const app = build();
    for (let i = 0; i < MAX_REQUESTS_PER_USER; i++) expect((await app.request(`/api/v1/workspaces/${WS}/trace`, { headers: as("ann") })).status).toBe(200);
    const over = await app.request(`/api/v1/workspaces/${WS}/trace`, { headers: as("ann") });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await app.request(`/api/v1/workspaces/${WS}/trace`, { headers: as("ben") })).status).toBe(200);
  });

  it(`chat turns: the ${MAX_TURNS_PER_USER + 1}th in a minute → 429`, async () => {
    const app = build();
    for (let i = 0; i < MAX_TURNS_PER_USER; i++) expect((await app.request(`/api/v1/workspaces/${WS}/chat`, { method: "POST", headers: as("cat") })).status).toBe(200);
    expect((await app.request(`/api/v1/workspaces/${WS}/chat`, { method: "POST", headers: as("cat") })).status).toBe(429);
  });

  it(`trace streams: the ${MAX_TRACE_STREAMS_PER_USER + 1}th open stream → 429; closing one frees a slot`, async () => {
    const app = build();
    const open: Response[] = [];
    for (let i = 0; i < MAX_TRACE_STREAMS_PER_USER; i++) {
      const r = await app.request(`/api/v1/workspaces/${WS}/trace/stream`, { headers: as("dan") });
      expect(r.status).toBe(200);
      open.push(r);
    }
    expect((await app.request(`/api/v1/workspaces/${WS}/trace/stream`, { headers: as("dan") })).status).toBe(429);
    await open[0]!.body!.cancel();
    const again = await app.request(`/api/v1/workspaces/${WS}/trace/stream`, { headers: as("dan") });
    expect(again.status).toBe(200);
    for (const r of [...open.slice(1), again]) await r.body!.cancel();
  });

  it(`API-key mints: the ${MAX_KEY_MINTS_PER_HOUR + 1}th in an hour → 429`, async () => {
    const app = build();
    const mint = () => app.request("/api/v1/auth/api-keys", { method: "POST", headers: as("eve"), body: JSON.stringify({ name: "k" }) });
    const first = (await (await mint()).json()) as { key: string };
    for (let i = 1; i < MAX_KEY_MINTS_PER_HOUR; i++) expect((await mint()).status).toBe(201);
    expect((await mint()).status).toBe(429);
    // A key still can't mint keys (auth on); only dev mode's local user is exempt.
    const byKey = await app.request("/api/v1/auth/api-keys", { method: "POST", headers: { Authorization: `Bearer ${first.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "k" }) });
    expect(byKey.status).toBe(403);
  });

  it("the hourly window resets after an hour; stream slots and budgets bound their tracking", () => {
    let t = 0;
    const b = new HourlyBudget(2, () => t);
    expect([b.take("u").ok, b.take("u").ok, b.take("u").ok]).toEqual([true, true, false]);
    t += 3_600_000;
    expect(b.take("u").ok).toBe(true);
    const s = new StreamSlots(1);
    const r = s.acquire("u")!;
    expect(s.acquire("u")).toBeNull();
    r();
    r(); // idempotent
    expect(s.count("u")).toBe(0);
  });
});

describe("the RPI validation budget (global)", () => {
  it("spent → a NEW token is refused (429) WITHOUT calling RPI; a cached valid user still gets in", async () => {
    const app = build();
    expect((await app.request(`/api/v1/workspaces/${WS}/trace`, { headers: as("cached") })).status).toBe(200); // validated + cached
    for (let i = 0; i < MAX_REMOTE_VALIDATIONS; i++) rpiValidationGuard.remoteValidations.take("server");
    const before = rpiCalls;
    const res = await app.request(`/api/v1/workspaces/${WS}/trace`, { headers: as("brand-new") });
    expect(res.status).toBe(429);
    expect(rpiCalls).toBe(before);
    expect((await app.request(`/api/v1/workspaces/${WS}/trace`, { headers: as("cached") })).status).toBe(200);
  });
});

describe("the A2A turn budget", () => {
  const fake = () => {
    const res = { code: 0, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, status(c: number) { this.code = c; return this; }, json() { return this; } };
    return res;
  };
  it(`each A2A message spends the user's turn budget: the ${MAX_TURNS_PER_USER + 1}th → 429; a GET is free`, () => {
    const mw = a2aTurnLimit(() => "rpi:a2a-user");
    let passed = 0;
    for (let i = 0; i < MAX_TURNS_PER_USER; i++) mw({ method: "POST" } as never, fake() as never, () => void passed++);
    const over = fake();
    mw({ method: "POST" } as never, over as never, () => void passed++);
    expect(passed).toBe(MAX_TURNS_PER_USER);
    expect(over.code).toBe(429);
    expect(Number(over.headers["Retry-After"])).toBeGreaterThan(0);
    mw({ method: "GET" } as never, fake() as never, () => void passed++);
    expect(passed).toBe(MAX_TURNS_PER_USER + 1);
  });
});

describe("the runtime-status cache is bounded", () => {
  it(`expired entries are swept and it never holds more than ${MAX_RUNTIME_STATUS_ENTRIES}`, () => {
    for (let i = 0; i < 200; i++) primeRuntimeStatusCache(`expired-${i}`, 0);
    for (let i = 0; i < MAX_RUNTIME_STATUS_ENTRIES + 100; i++) primeRuntimeStatusCache(`live-${i}`, Date.now() + 60_000);
    boundRuntimeStatusCache();
    expect(runtimeStatusCacheSize()).toBe(MAX_RUNTIME_STATUS_ENTRIES);
  });
});

describe("index.ts wires the bounds", () => {
  const index = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");
  it("the flood ceiling before auth; the per-user budget after; turn budgets on the chat and AG-UI routes", () => {
    const at = (s: string) => index.indexOf(s);
    expect(at('app.use("/api/v1/*", peerFloodLimit(limiter));')).toBeGreaterThan(-1);
    expect(at('app.use("/api/v1/*", peerFloodLimit(limiter));')).toBeLessThan(at('app.use("/api/v1/*", authMiddleware);'));
    expect(at('app.use("/api/v1/*", userRequestLimit(limiter));')).toBeGreaterThan(at('app.use("/api/v1/*", authMiddleware);'));
    expect(index).toContain('app.on("POST", "/api/v1/workspaces/:workspaceId/chat", turnLimit());');
    expect(index).toContain('app.on("POST", "/api/v1/workspaces/:workspaceId/threads/:threadId/runs/:runId/stream", turnLimit());');
    expect(at('app.on("POST", "/api/v1/workspaces/:workspaceId/chat", turnLimit());')).toBeLessThan(at('app.route("/api/v1/workspaces", chatRoutes);'));
  });
  it("the body is capped at 4 MiB and the serve mode pinned", () => {
    expect(index).toContain("const MAX_BODY_BYTES = 4 * 1024 * 1024;");
    expect(index).toContain("maxRequestBodySize: MAX_BODY_BYTES,");
    expect(index).toContain("...SERVE_MODE,");
  });
});

describe("DEV MODE (auth off): the local user is never throttled", () => {
  it("past every per-user budget: requests, turns, streams, mints all still pass", async () => {
    process.env.AUTH_REQUIRED = "false";
    try {
      const app = build();
      for (let i = 0; i < MAX_REQUESTS_PER_USER + 10; i++) expect((await app.request(`/api/v1/workspaces/${WS}/trace`)).status).toBe(200);
      for (let i = 0; i < MAX_TURNS_PER_USER + 5; i++) expect((await app.request(`/api/v1/workspaces/${WS}/chat`, { method: "POST" })).status).toBe(200);
      const streams: Response[] = [];
      for (let i = 0; i < MAX_TRACE_STREAMS_PER_USER + 2; i++) {
        const r = await app.request(`/api/v1/workspaces/${WS}/trace/stream`);
        expect(r.status).toBe(200);
        streams.push(r);
      }
      for (const r of streams) await r.body!.cancel();
      for (let i = 0; i < MAX_KEY_MINTS_PER_HOUR + 3; i++) {
        expect((await app.request("/api/v1/auth/api-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "k" }) })).status).toBe(201);
      }
      const a2a = a2aTurnLimit(() => "dev");
      let passed = 0;
      for (let i = 0; i < MAX_TURNS_PER_USER + 5; i++) a2a({ method: "POST" } as never, {} as never, () => void passed++);
      expect(passed).toBe(MAX_TURNS_PER_USER + 5);
    } finally {
      process.env.AUTH_REQUIRED = "true";
    }
  });
});
