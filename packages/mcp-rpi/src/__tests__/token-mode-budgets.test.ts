/**
 * The token-mode budgets on the real entry point (src/http.ts, spawned with every
 * key of the binary env contract pinned) against an in-test stand-in RPI that
 * counts its validate-token-status calls. Each budget is bitten:
 *   - token-less requests never reach RPI; the per-address ceiling (1200/min) caps them;
 *   - invented tokens: 10 failures per address reach RPI, then 429 — a token already
 *     verified still gets in; a concurrent burst can't overshoot the 10;
 *   - the server-wide remote-validation ceiling (600/min);
 *   - single-flight: N concurrent requests with one new token → one RPI call;
 *   - the per-user request budget (120/min), shared by one user's tokens;
 *   - the per-user session cap (20) across tokens, the server-wide cap (200);
 *   - a body over 4 MiB is refused in token mode, not in env-credential mode.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_AUTH_FAILURES_PER_PEER, MAX_REQUESTS_PER_PEER, MAX_REQUESTS_PER_USER } from "../rate-limit.js";
import { MAX_SESSIONS_PER_OWNER } from "../session-store.js";
import { MAX_REMOTE_VALIDATIONS } from "../validation-guard.js";
import { BINARY_ENV_KEYS } from "../../scripts/binary-env";

// ---- the stand-in RPI ----
let validations = 0;
let validateDelayMs = 0;
const rpi = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/v2/authentication/login-settings") return Response.json({ settings: [] });
    if (path === "/api/v2/authentication/validate-token-status") {
      validations++;
      if (validateDelayMs) await Bun.sleep(validateDelayMs);
      const ok = !(req.headers.get("authorization") ?? "").includes("junk");
      return ok ? Response.json({ status: "valid" }) : new Response("no", { status: 401 });
    }
    if (path === "/connect/token") return Response.json({ access_token: "proxy-access", token_type: "Bearer", expires_in: 3600 });
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => rpi.stop(true));

// ---- the server under test ----
const ENTRY = join(import.meta.dir, "../http.ts");
let child: ChildProcess | undefined;
let cwd = "";
let base = "";
beforeEach(() => {
  validations = 0;
  validateDelayMs = 0;
});
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = "";
});

/** A port the OS just handed out (free now; boot retries if another process takes it first). */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  return port as number;
}

async function boot(env: Record<string, string> = {}): Promise<void> {
  let log = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = freePort();
    cwd ||= mkdtempSync(join(tmpdir(), "rp-mcp-budgets-"));
    log = "";
    child = spawn(process.execPath, ["run", ENTRY], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        ...Object.fromEntries(BINARY_ENV_KEYS.map((k) => [k.key, ""])),
        RPI_MCP_HTTP_PORT: String(port),
        RPI_INTEGRATION_API_URL: `http://127.0.0.1:${rpi.port}`,
        AUTH_REQUIRED: "true",
        RPI_PROXY_ENABLED: "false",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => (log += d));
    child.stderr?.on("data", (d) => (log += d));
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100 && !/EADDRINUSE/.test(log); i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) return void (validations = 0);
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    child.kill("SIGKILL");
    if (!/EADDRINUSE/.test(log)) break;
  }
  throw new Error(`server did not come up:\n${log}`);
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A JWT-shaped token naming `sub` (the stand-in accepts any token without "junk"). */
const jwtFor = (sub: string, n: number | string) =>
  `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: "https://rpi.test/identity", sub, n })}.sig`;

/** A request that passes auth and stops cheaply: an unknown session → 404. */
async function probe(token?: string): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": "none", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  await res.arrayBuffer();
  return res.status;
}

async function initialize(token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "budget-test", version: "1" } },
    }),
  });
  return { status: res.status, body: await res.text() };
}

/** Run `n` calls, `width` at a time, in order; the statuses in call order. */
async function inBatches(n: number, width: number, call: (i: number) => Promise<number>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += width) {
    out.push(...(await Promise.all(Array.from({ length: Math.min(width, n - i) }, (_, k) => call(i + k)))));
  }
  return out;
}
const count = (xs: number[], s: number) => xs.filter((x) => x === s).length;

describe("token mode: what a caller can make RPI do", () => {
  it(`token-less requests never reach RPI; the per-address ceiling (${MAX_REQUESTS_PER_PEER}/min) caps them`, async () => {
    await boot();
    const statuses = await inBatches(MAX_REQUESTS_PER_PEER + 50, 100, () => probe());
    // Every path counts: the boot's one /health was the first request of the window.
    expect(count(statuses, 401)).toBe(MAX_REQUESTS_PER_PEER - 1);
    expect(count(statuses, 429)).toBe(51);
    expect(validations).toBe(0);
  }, 60_000);

  it(`invented tokens: ${MAX_AUTH_FAILURES_PER_PEER} reach RPI, then 429 without calling it; a token verified before still gets in`, async () => {
    await boot();
    expect(await probe("good-early")).toBe(404);
    expect(validations).toBe(1);
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) statuses.push(await probe(`junk-${i}`));
    expect(statuses.slice(0, MAX_AUTH_FAILURES_PER_PEER).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(MAX_AUTH_FAILURES_PER_PEER).every((s) => s === 429)).toBe(true);
    expect(validations).toBe(1 + MAX_AUTH_FAILURES_PER_PEER);
    // The cached valid token is answered locally — never blocked by the failures.
    expect(await probe("good-early")).toBe(404);
  }, 60_000);

  it(`a concurrent burst of invented tokens from one address: still exactly ${MAX_AUTH_FAILURES_PER_PEER} reach RPI`, async () => {
    await boot();
    validateDelayMs = 100;
    const statuses = await inBatches(1000, 100, (i) => probe(`junk-burst-${i}`));
    expect(count(statuses, 401)).toBe(MAX_AUTH_FAILURES_PER_PEER);
    expect(count(statuses, 429)).toBe(1000 - MAX_AUTH_FAILURES_PER_PEER);
    expect(validations).toBe(MAX_AUTH_FAILURES_PER_PEER);
  }, 60_000);

  it(`the server-wide remote-validation ceiling: ${MAX_REMOTE_VALIDATIONS}/min, then 429 without calling RPI`, async () => {
    await boot();
    // At most MAX_AUTH_FAILURES_PER_PEER new validations in flight per address.
    const statuses = await inBatches(MAX_REMOTE_VALIDATIONS + 25, MAX_AUTH_FAILURES_PER_PEER, (i) => probe(`good-${i}`));
    expect(count(statuses, 404)).toBe(MAX_REMOTE_VALIDATIONS);
    expect(count(statuses, 429)).toBe(25);
    expect(validations).toBe(MAX_REMOTE_VALIDATIONS);
  }, 60_000);

  it(`new tokens from one address: ${MAX_AUTH_FAILURES_PER_PEER} validations in flight at once; the next is told to retry in 1 s`, async () => {
    await boot();
    validateDelayMs = 300;
    const statuses = await Promise.all(Array.from({ length: MAX_AUTH_FAILURES_PER_PEER + 5 }, (_, i) => probe(`good-wide-${i}`)));
    expect(count(statuses, 404)).toBe(MAX_AUTH_FAILURES_PER_PEER);
    expect(count(statuses, 429)).toBe(5);
    // Once they answer (valid), the address validates new tokens again.
    expect(await probe("good-after")).toBe(404);
  }, 60_000);

  it("single-flight: 50 concurrent requests with one new token → ONE RPI call, all admitted", async () => {
    await boot();
    validateDelayMs = 200;
    const statuses = await Promise.all(Array.from({ length: 50 }, () => probe("good-shared")));
    expect(count(statuses, 404)).toBe(50);
    expect(validations).toBe(1);
  }, 60_000);

  it(`the per-user request budget (${MAX_REQUESTS_PER_USER}/min) is keyed on the user, shared by their tokens`, async () => {
    await boot();
    const a = jwtFor("alice", "a");
    const b = jwtFor("alice", "b");
    const half = MAX_REQUESTS_PER_USER / 2;
    const first = await inBatches(half, 20, () => probe(a));
    const second = await inBatches(half, 20, () => probe(b));
    expect([...first, ...second].every((s) => s === 404)).toBe(true);
    expect(await probe(b)).toBe(429);
    expect(await probe(a)).toBe(429);
    // Another user is unaffected.
    expect(await probe(jwtFor("bob", 1))).toBe(404);
    expect(validations).toBe(3);
  }, 60_000);

  it(`the per-user session cap (${MAX_SESSIONS_PER_OWNER}) holds across the user's tokens; another user still opens one`, async () => {
    await boot();
    for (let i = 0; i < MAX_SESSIONS_PER_OWNER; i++) expect((await initialize(jwtFor("alice", i))).status).toBe(200);
    expect(await initialize(jwtFor("alice", "one-more"))).toEqual({
      status: 429,
      body: JSON.stringify({ error: "Too many open sessions for this caller" }),
    });
    expect((await initialize(jwtFor("bob", 0))).status).toBe(200);
  }, 60_000);

  it("the server-wide session cap is 200 in token mode", async () => {
    await boot();
    const statuses = await inBatches(200, MAX_AUTH_FAILURES_PER_PEER, async (i) => (await initialize(jwtFor(`user-${i}`, i))).status);
    expect(count(statuses, 200)).toBe(200);
    expect(await initialize(jwtFor("user-201", 201))).toEqual({
      status: 503,
      body: JSON.stringify({ error: "Session limit reached — try again later" }),
    });
  }, 120_000);
});

describe("the request body limit", () => {
  const MiB = 1024 * 1024;
  const post = async (bytes: number, token?: string) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: "x".repeat(bytes),
    });
    await res.arrayBuffer();
    return res.status;
  };

  it("token mode: a body over 4 MiB → 413; at 4 MiB it is read (no 413)", async () => {
    await boot();
    expect(await post(4 * MiB + 1, "good-body")).toBe(413);
    expect(await post(4 * MiB, "good-body")).not.toBe(413);
  }, 60_000);

  it("env-credential mode: unchanged — a 5 MiB body is read (no 413)", async () => {
    await boot({
      AUTH_REQUIRED: "false",
      RPI_PROXY_ENABLED: "true",
      RPI_PROXY_USER: "svc",
      RPI_PROXY_PASS: "stand-in-only",
      RPI_OAUTH_CLIENT_ID: "cid",
      RPI_OAUTH_CLIENT_SECRET: "stand-in-only",
    });
    expect(await post(5 * MiB)).not.toBe(413);
  }, 60_000);
});
