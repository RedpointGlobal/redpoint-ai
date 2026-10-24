/**
 * The boot-time proxy login check (reported on /health as proxyLogin): accepted →
 * "ok" (and the token is cached); refused by RPI's token endpoint (400/401/403) →
 * "rejected"; anything else — a server error, no answer — → "unreachable".
 */
import { describe, it, expect, afterEach } from "bun:test";
import { RPIAuthService } from "../client/rpi-auth.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const svc = () => new RPIAuthService("https://rpi.example.test", "cid", "sec", "native.user", "pw");
const answering = (status: number) => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return status === 200
      ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), { status })
      : new Response("{}", { status, statusText: "x" });
  }) as unknown as typeof fetch;
  return () => calls;
};

describe("checkProxyLogin", () => {
  it("accepted → ok, and the token is cached (no second login)", async () => {
    const calls = answering(200);
    const s = svc();
    expect(await s.checkProxyLogin()).toBe("ok");
    expect(await s.getProxyToken()).toBe("tok");
    expect(calls()).toBe(1);
  });
  for (const status of [400, 401, 403])
    it(`HTTP ${status} from the token endpoint → rejected`, async () => {
      answering(status);
      expect(await svc().checkProxyLogin()).toBe("rejected");
    });
  it("a server error → unreachable", async () => {
    answering(503);
    expect(await svc().checkProxyLogin()).toBe("unreachable");
  });
  it("no answer (a network error, or past the bound) → unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await svc().checkProxyLogin()).toBe("unreachable");
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await svc().checkProxyLogin(30)).toBe("unreachable");
  });
});
