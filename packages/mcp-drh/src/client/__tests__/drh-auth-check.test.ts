/**
 * DRHAuthService.checkToken — the token check at the gate in (pinned) token mode:
 * GET /api-op/v1/databases/default with the caller's token and X-ClientId = the
 * pinned tenant. ONLY a 401 means invalid; any other status admits the token (DRH
 * answers it only for a token it authenticated). Cached 30 s, single-flight, capped
 * (LRU), and only a NEW check asks the admission.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DRHAuthService, MAX_VALIDATION_CACHE_ENTRIES } from "../drh-auth.js";

const BASE = "https://drh.example.test";
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; auth: string | null; tenant: string | null }> = [];
let status = 200;
let delayMs = 0;
let failNetwork = false;

beforeEach(() => {
  calls = [];
  status = 200;
  delayMs = 0;
  failNetwork = false;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), auth: h.get("authorization"), tenant: h.get("x-clientid") });
    if (failNetwork) throw new Error("network down");
    if (delayMs) await Bun.sleep(delayMs);
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("checkToken: the request", () => {
  it("asks GET databases/default with the caller's token and the pinned tenant", async () => {
    await new DRHAuthService(BASE).checkToken("tok-a", "t-pinned");
    expect(calls).toEqual([{ url: `${BASE}/api-op/v1/databases/default`, auth: "Bearer tok-a", tenant: "t-pinned" }]);
  });
});

describe("checkToken: the status mapping (only 401 rejects)", () => {
  for (const s of [200, 400, 403, 404, 500, 503]) {
    it(`${s} → valid (DRH authenticated the token)`, async () => {
      status = s;
      expect(await new DRHAuthService(BASE).checkToken("tok", "t")).toEqual({ result: "valid" });
    });
  }
  it("401 → invalid", async () => {
    status = 401;
    expect(await new DRHAuthService(BASE).checkToken("tok", "t")).toEqual({ result: "invalid" });
  });
  it("no answer (network error) → unavailable, not cached: the next request checks again", async () => {
    failNetwork = true;
    const auth = new DRHAuthService(BASE);
    expect(await auth.checkToken("tok", "t")).toEqual({ result: "unavailable" });
    expect(auth.validationCacheSize).toBe(0);
    failNetwork = false;
    expect(await auth.checkToken("tok", "t")).toEqual({ result: "valid" });
    expect(calls.length).toBe(2);
  });
});

describe("checkToken: cache, single-flight, admission", () => {
  it("an answer is cached: the same token again costs DRH nothing (valid and invalid alike)", async () => {
    const auth = new DRHAuthService(BASE);
    await auth.checkToken("good", "t");
    await auth.checkToken("good", "t");
    status = 401;
    await auth.checkToken("bad", "t");
    expect(await auth.checkToken("bad", "t")).toEqual({ result: "invalid" });
    expect(calls.length).toBe(2);
  });

  it("the cache is per tenant", async () => {
    const auth = new DRHAuthService(BASE);
    await auth.checkToken("tok", "t-1");
    await auth.checkToken("tok", "t-2");
    expect(calls.map((c) => c.tenant)).toEqual(["t-1", "t-2"]);
  });

  it("single-flight: 50 concurrent checks of one token → ONE DRH call, all get its answer", async () => {
    delayMs = 50;
    const auth = new DRHAuthService(BASE);
    const results = await Promise.all(Array.from({ length: 50 }, () => auth.checkToken("same", "t")));
    expect(results.every((r) => r.result === "valid")).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("only the check that STARTS a DRH call is admitted; joiners and cache hits are not, and settle gets the answer", async () => {
    delayMs = 50;
    status = 401;
    const auth = new DRHAuthService(BASE);
    let admissions = 0;
    const settled: string[] = [];
    const admit = () => (admissions++, { ok: true as const, settle: (r: string) => void settled.push(r) });
    await Promise.all(Array.from({ length: 20 }, () => auth.checkToken("junk", "t", admit)));
    await auth.checkToken("junk", "t", admit);
    expect(admissions).toBe(1);
    expect(settled).toEqual(["invalid"]);
  });

  it("a refused admission → 'refused' with its Retry-After, and DRH is NOT called", async () => {
    const r = await new DRHAuthService(BASE).checkToken("t", "t", () => ({ ok: false, retryAfterSec: 7 }));
    expect(r).toEqual({ result: "refused", retryAfterSec: 7 });
    expect(calls.length).toBe(0);
  });

  it(`the cache is capped at MAX_VALIDATION_CACHE_ENTRIES (${MAX_VALIDATION_CACHE_ENTRIES}); the least recently used goes first`, async () => {
    const auth = new DRHAuthService(BASE);
    await auth.checkToken("first", "t");
    await auth.checkToken("second", "t");
    for (let i = 0; i < MAX_VALIDATION_CACHE_ENTRIES - 2; i++) await auth.checkToken(`k-${i}`, "t");
    expect(auth.validationCacheSize).toBe(MAX_VALIDATION_CACHE_ENTRIES);
    await auth.checkToken("first", "t"); // touch → most recently used
    await auth.checkToken("one-more", "t"); // evicts "second"
    expect(auth.validationCacheSize).toBe(MAX_VALIDATION_CACHE_ENTRIES);
    const before = calls.length;
    await auth.checkToken("first", "t");
    expect(calls.length).toBe(before);
    await auth.checkToken("second", "t");
    expect(calls.length).toBe(before + 1);
  });
});
