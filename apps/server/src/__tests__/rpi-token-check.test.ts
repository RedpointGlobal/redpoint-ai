/**
 * The app server's RPI token check (../auth/rpi-token-check.ts): cached, capped,
 * single-flight; a refused admission never calls RPI; a network error is
 * "unavailable" and NOT cached. RPI is a stubbed fetch that counts its calls.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MAX_VALIDATION_CACHE_ENTRIES, checkRpiToken, resetValidationCache, validationCacheSize } from "../auth/rpi-token-check.js";

const BASE = "http://rpi.test";
const realFetch = globalThis.fetch;
let calls = 0;
const stub = (impl: (token: string) => Promise<Response>) => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls++;
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
    return impl(token);
  }) as unknown as typeof fetch;
};
const known = (token: string) =>
  Promise.resolve(token.startsWith("good") ? Response.json({ id: `GUID-${token}` }) : new Response("no", { status: 401 }));

beforeEach(() => {
  resetValidationCache();
  calls = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("checkRpiToken", () => {
  it("a valid token → its stable id (lowercased); asked again → served from the cache", async () => {
    stub(known);
    expect(await checkRpiToken("good-1", BASE)).toEqual({ result: "valid", stableId: "guid-good-1" });
    expect(await checkRpiToken("good-1", BASE)).toEqual({ result: "valid", stableId: "guid-good-1" });
    expect(calls).toBe(1);
  });

  it("an invalid token is cached as invalid too (one call)", async () => {
    stub(known);
    expect((await checkRpiToken("junk", BASE)).result).toBe("invalid");
    expect((await checkRpiToken("junk", BASE)).result).toBe("invalid");
    expect(calls).toBe(1);
  });

  it("an ok answer without a usable id (absent, or the empty GUID) is invalid", async () => {
    stub(() => Promise.resolve(Response.json({ id: "00000000-0000-0000-0000-000000000000" })));
    expect((await checkRpiToken("t1", BASE)).result).toBe("invalid");
    stub(() => Promise.resolve(Response.json({})));
    expect((await checkRpiToken("t2", BASE)).result).toBe("invalid");
  });

  it("single-flight: concurrent checks of one token share ONE RPI call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stub(async (t) => (await gate, known(t)));
    const all = Promise.all(Array.from({ length: 10 }, () => checkRpiToken("good-burst", BASE)));
    release();
    const results = await all;
    expect(calls).toBe(1);
    expect(results.every((r) => r.result === "valid")).toBe(true);
  });

  it("a refused admission → 'refused' WITHOUT calling RPI; a cached token never asks", async () => {
    stub(known);
    let asked = 0;
    const refuse = () => ((asked++, { ok: false as const, retryAfterSec: 7 }));
    expect(await checkRpiToken("good-new", BASE, refuse)).toEqual({ result: "refused", retryAfterSec: 7 });
    expect(calls).toBe(0);
    await checkRpiToken("good-cached", BASE);
    expect((await checkRpiToken("good-cached", BASE, refuse)).result).toBe("valid");
    expect(asked).toBe(1);
  });

  it("a network error is 'unavailable' and NOT cached: the next request asks again", async () => {
    stub(() => Promise.reject(new Error("ECONNREFUSED")));
    expect((await checkRpiToken("good-blip", BASE)).result).toBe("unavailable");
    expect(validationCacheSize()).toBe(0);
    stub(known);
    expect((await checkRpiToken("good-blip", BASE)).result).toBe("valid");
  });

  it(`the cache holds at most ${MAX_VALIDATION_CACHE_ENTRIES} tokens (the least recently used go first)`, async () => {
    stub(known);
    for (let i = 0; i < MAX_VALIDATION_CACHE_ENTRIES + 50; i++) await checkRpiToken(`junk-${i}`, BASE);
    expect(validationCacheSize()).toBe(MAX_VALIDATION_CACHE_ENTRIES);
    calls = 0;
    await checkRpiToken(`junk-${MAX_VALIDATION_CACHE_ENTRIES + 49}`, BASE); // newest: still cached
    expect(calls).toBe(0);
    await checkRpiToken("junk-0", BASE); // oldest: evicted → asked again
    expect(calls).toBe(1);
  }, 60_000);
});
