/**
 * boundedFetch (../client/upstream-limits.ts): a per-request timeout and a
 * response-size cap on every DRH request, surfaced as clean errors; the caller's
 * own abort is not reported as a timeout. The DRHApiClient / DRHAuthService wiring
 * (send, signon) is covered by their own tests.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { boundedFetch, UPSTREAM_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "../client/upstream-limits.js";

const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

describe("boundedFetch", () => {
  it("pinned limits: 60 s per request, 16 MiB per response", () => {
    expect([UPSTREAM_TIMEOUT_MS, MAX_RESPONSE_BYTES]).toEqual([60_000, 16 * 1024 * 1024]);
  });
  it("a request past the timeout → a clean 'timed out' error", async () => {
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    await expect(boundedFetch("https://x.test/a", {}, "DRH request", { timeoutMs: 30, maxBytes: 1000 })).rejects.toThrow("DRH request timed out after 0.03s");
  });
  it("the caller's own abort is not reported as a timeout", async () => {
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = boundedFetch("https://x.test/a", { signal: ac.signal }, "DRH request", { timeoutMs: 5000, maxBytes: 1000 });
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
  });
  it("a body over the cap — declared or streamed — → a clean 'exceeded' error", async () => {
    globalThis.fetch = (async () => new Response("x".repeat(50), { headers: { "content-length": "50" } })) as unknown as typeof fetch;
    const declared = await boundedFetch("https://x.test/a", {}, "DRH request", { timeoutMs: 1000, maxBytes: 10 });
    await expect(declared.text()).rejects.toThrow("DRH request response exceeded 10 bytes");
    globalThis.fetch = (async () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("y".repeat(8))); c.enqueue(new TextEncoder().encode("y".repeat(8))); c.close(); } }))) as unknown as typeof fetch;
    const streamed = await boundedFetch("https://x.test/a", {}, "DRH request", { timeoutMs: 1000, maxBytes: 10 });
    await expect(streamed.text()).rejects.toThrow("DRH request response exceeded 10 bytes");
  });
  it("within the bounds → the body, unchanged", async () => {
    globalThis.fetch = (async () => new Response('{"a":1}')) as unknown as typeof fetch;
    expect(await (await boundedFetch("https://x.test/a", {})).text()).toBe('{"a":1}');
  });
});
