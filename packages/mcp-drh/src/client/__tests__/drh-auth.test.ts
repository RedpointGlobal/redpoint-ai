import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DRHAuthService } from "../drh-auth.js";

const BASE = "https://drh.example.test";
const realFetch = globalThis.fetch;

let signonCount: number;
let lastSignonBody: unknown;

/** Mock fetch: signon → fresh opaque token each call; signoff → 200. */
function installFetch() {
  signonCount = 0;
  lastSignonBody = undefined;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/auth/signon")) {
      signonCount++;
      lastSignonBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({ token: `tok-${signonCount}` }), {
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
  globalThis.fetch = realFetch;
});

describe("DRHAuthService", () => {
  it("signon POSTs {username,password} to /auth/signon and returns the opaque token", async () => {
    const svc = new DRHAuthService(BASE, "u", "p");
    const token = await svc.signon("alice", "secret");
    expect(token).toBe("tok-1");
    expect(lastSignonBody).toEqual({ username: "alice", password: "secret" });
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

  it("getProxyToken re-signons after the TTL expires", async () => {
    const svc = new DRHAuthService(BASE, "u", "p", 0); // 0s TTL → always stale
    await svc.getProxyToken();
    const second = await svc.getProxyToken();
    expect(second).toBe("tok-2");
    expect(signonCount).toBe(2);
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
