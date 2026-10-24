import { describe, it, expect, beforeEach, afterEach, mock, setSystemTime } from "bun:test";
import { DRHAuthService, effectiveTtlMs } from "../drh-auth.js";

const BASE = "https://drh.example.test";
const realFetch = globalThis.fetch;

let signonCount: number;
let lastSignonBody: unknown;
let authUrls: string[] = [];
/** The expiresAfter the mocked sign-on replies with (undefined: the field is absent). */
let replyExpiresAfter: number | undefined;

/** Mock fetch: signon → a fresh accessToken each call (the v2 reply shape); signoff → 200. */
function installFetch() {
  signonCount = 0;
  lastSignonBody = undefined;
  authUrls = [];
  replyExpiresAfter = 3600;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/auth/sign")) authUrls.push(String(url));
    if (String(url).includes("/auth/signon")) {
      signonCount++;
      lastSignonBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({ accessToken: `tok-${signonCount}`, refreshToken: "r", expiresAfter: replyExpiresAfter, idleTimeout: 1800 }), {
        status: 200,
      });
    }
    if (String(url).includes("/auth/signoff")) {
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

beforeEach(installFetch);
afterEach(() => {
  setSystemTime();
  globalThis.fetch = realFetch;
});

describe("DRHAuthService", () => {
  it("signon POSTs {username,password} to /api/v2/auth/signon and returns the accessToken", async () => {
    const svc = new DRHAuthService(BASE, "u", "p");
    const token = await svc.signon("alice", "secret");
    expect(token).toBe("tok-1");
    expect(lastSignonBody).toEqual({ username: "alice", password: "secret" });
    expect(authUrls).toEqual([`${BASE}/api/v2/auth/signon`]);
  });

  it("signoff POSTs to /api/v2/auth/signoff (the legacy /api-op/v1/auth/* is not called)", async () => {
    const svc = new DRHAuthService(BASE, "u", "p");
    await svc.signoff("tok-x");
    expect(authUrls).toEqual([`${BASE}/api/v2/auth/signoff`]);
  });

  it("only the auth calls moved: sign-on is v2, the token check stays on the v1 data API", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("/auth/signon")) return new Response(JSON.stringify({ accessToken: "tok-v2" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new DRHAuthService(BASE, "u", "p");
    const token = await svc.getProxyToken();
    expect(await svc.checkToken(token, "t-1")).toEqual({ result: "valid" });
    expect(urls).toEqual([`${BASE}/api/v2/auth/signon`, `${BASE}/api-op/v1/databases/default`]);
  });

  it("a legacy-shaped signon reply ({ token }, no accessToken) is refused", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ token: "legacy" }), { status: 200 })) as unknown as typeof fetch;
    await expect(new DRHAuthService(BASE, "u", "p").signon("alice", "secret")).rejects.toThrow(/returned no token/);
  });

  it("signon throws on a non-OK response", async () => {
    globalThis.fetch = mock(async () =>
      new Response("bad creds", { status: 401 }),
    ) as unknown as typeof fetch;
    const svc = new DRHAuthService(BASE, "u", "p");
    await expect(svc.signon("x", "y")).rejects.toThrow(/signon failed: 401/);
  });

  it("getProxyToken caches within the TTL (one signon for repeated calls)", async () => {
    const svc = new DRHAuthService(BASE, "u", "p", 300);
    const a = await svc.getProxyToken();
    const b = await svc.getProxyToken();
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(signonCount).toBe(1);
  });

  it("the proxy token is cached for 90% of the reply's expiresAfter (3600 s → 3240 s), not the configured 300 s", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z").getTime();
    setSystemTime(t0);
    const svc = new DRHAuthService(BASE, "u", "p", 300);
    expect(await svc.getProxyToken()).toBe("tok-1");
    setSystemTime(t0 + 301_000); // past the old fixed 300 s: still cached
    expect(await svc.getProxyToken()).toBe("tok-1");
    setSystemTime(t0 + 3_239_000); // just inside 90% of 3600 s
    expect(await svc.getProxyToken()).toBe("tok-1");
    setSystemTime(t0 + 3_241_000); // just past it: signed on again, before the token's own expiry
    expect(await svc.getProxyToken()).toBe("tok-2");
    expect(signonCount).toBe(2);
  });

  it("a reply without expiresAfter (or a non-positive one) falls back to the configured TTL", async () => {
    for (const absent of [undefined, 0, -5]) {
      installFetch();
      replyExpiresAfter = absent;
      const t0 = new Date("2026-10-19T12:00:00Z").getTime();
      setSystemTime(t0);
      const svc = new DRHAuthService(BASE, "u", "p", 300);
      expect(await svc.getProxyToken()).toBe("tok-1");
      setSystemTime(t0 + 299_000);
      expect(await svc.getProxyToken()).toBe("tok-1");
      setSystemTime(t0 + 301_000);
      expect(await svc.getProxyToken()).toBe("tok-2");
    }
  });

  it("effectiveTtlMs: 90% of a positive expiresAfter, else the fallback", () => {
    expect(effectiveTtlMs(3600, 300_000)).toBe(3_240_000);
    expect(effectiveTtlMs(10, 300_000)).toBe(9_000);
    expect(effectiveTtlMs(undefined, 300_000)).toBe(300_000);
    expect(effectiveTtlMs(0, 300_000)).toBe(300_000);
    expect(effectiveTtlMs(-1, 300_000)).toBe(300_000);
  });

  it("deduplicates concurrent refreshes into a single signon", async () => {
    const svc = new DRHAuthService(BASE, "u", "p", 300);
    const [a, b, c] = await Promise.all([
      svc.getProxyToken(),
      svc.getProxyToken(),
      svc.getProxyToken(),
    ]);
    expect([a, b, c]).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(signonCount).toBe(1);
  });

  it("invalidateProxyToken forces a re-signon on the next call", async () => {
    const svc = new DRHAuthService(BASE, "u", "p", 300);
    await svc.getProxyToken();
    svc.invalidateProxyToken();
    const next = await svc.getProxyToken();
    expect(next).toBe("tok-2");
    expect(signonCount).toBe(2);
  });

  it("getProxyToken throws when the proxy user is not configured", async () => {
    const svc = new DRHAuthService(BASE); // no creds
    expect(svc.proxyEnabled).toBe(false);
    await expect(svc.getProxyToken()).rejects.toThrow(/proxy user is not configured/i);
  });
});
