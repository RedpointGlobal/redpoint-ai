import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DRHAuthService } from "../drh-auth.js";
import { DRHApiClient } from "../drh-api.js";

const BASE = "https://drh.example.test";
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[];
let signonCount: number;
let apiResponses: Array<{ status: number; body: string }>;

/**
 * URL-aware mock: /auth/signon → fresh `proxy-N` token; any other path pops the
 * next queued response from `apiResponses` (default 200 "{}").
 */
function installFetch() {
  calls = [];
  signonCount = 0;
  apiResponses = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    calls.push({ url: String(url), method, headers, body: init?.body as string });
    if (String(url).includes("/auth/signon")) {
      signonCount++;
      return new Response(JSON.stringify({ token: `proxy-${signonCount}` }), {
        status: 200,
      });
    }
    const next = apiResponses.shift() ?? { status: 200, body: "{}" };
    return new Response(next.body, { status: next.status });
  }) as unknown as typeof fetch;
}

function apiCalls(): Call[] {
  return calls.filter((c) => !c.url.includes("/auth/signon"));
}

beforeEach(installFetch);
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("DRHApiClient", () => {
  function client(defaultClientId = "client-default") {
    const auth = new DRHAuthService(BASE, "svc", "pw", 300);
    return new DRHApiClient(BASE, auth, defaultClientId);
  }

  it("attaches the proxy token as Authorization and the default X-ClientId", async () => {
    apiResponses = [{ status: 200, body: JSON.stringify({ ok: true }) }];
    const out = await client().request("GET", "/api-op/v1/databases");
    expect(out).toEqual({ ok: true });
    const c = apiCalls()[0];
    expect(c.headers.Authorization).toBe("Bearer proxy-1"); // Bearer per the DRH API contract
    expect(c.headers["X-ClientId"]).toBe("client-default");
    expect(c.url).toBe(`${BASE}/api-op/v1/databases`);
  });

  it("uses a per-call clientId override", async () => {
    apiResponses = [{ status: 200, body: "{}" }];
    await client().request("GET", "/api-op/v1/databases", { clientId: "tenant-X" });
    expect(apiCalls()[0].headers["X-ClientId"]).toBe("tenant-X");
  });

  it("uses a per-user token instead of the proxy token (no signon)", async () => {
    apiResponses = [{ status: 200, body: "{}" }];
    await client().request("GET", "/api-op/v1/databases", { userToken: "user-tok" });
    expect(apiCalls()[0].headers.Authorization).toBe("Bearer user-tok");
    expect(signonCount).toBe(0); // never touched the proxy
  });

  it("on a 401 for a proxy call: invalidates, re-signons, retries ONCE with the fresh token", async () => {
    apiResponses = [
      { status: 401, body: "expired" },
      { status: 200, body: JSON.stringify({ ok: true }) },
    ];
    const out = await client().request("GET", "/api-op/v1/databases");
    expect(out).toEqual({ ok: true });
    const ac = apiCalls();
    expect(ac.length).toBe(2);
    expect(ac[0].headers.Authorization).toBe("Bearer proxy-1");
    expect(ac[1].headers.Authorization).toBe("Bearer proxy-2"); // re-signed on
    expect(signonCount).toBe(2);
  });

  it("does NOT retry a 401 on a per-user token — surfaces it", async () => {
    apiResponses = [{ status: 401, body: "nope" }];
    await expect(
      client().request("GET", "/api-op/v1/databases", { userToken: "bad" }),
    ).rejects.toThrow(/401/);
    expect(apiCalls().length).toBe(1); // no retry
    expect(signonCount).toBe(0);
  });

  it("serializes a JSON body and sets Content-Type", async () => {
    apiResponses = [{ status: 200, body: "{}" }];
    await client().request("POST", "/api-op/v1/databases", { body: { name: "db1" } });
    const c = apiCalls()[0];
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(c.body!)).toEqual({ name: "db1" });
  });

  it("builds a query string, dropping undefined/null", async () => {
    apiResponses = [{ status: 200, body: "{}" }];
    await client().request("GET", "/api-op/v1/feeds", {
      query: { pageSize: 20, cursor: undefined, active: true },
    });
    expect(apiCalls()[0].url).toBe(`${BASE}/api-op/v1/feeds?pageSize=20&active=true`);
  });

  it("returns raw text when raw:true (CSV endpoints)", async () => {
    apiResponses = [{ status: 200, body: "a,b,c\n1,2,3" }];
    const out = await client().request("GET", "/api-op/v1/feeds/1/columns", { raw: true });
    expect(out).toBe("a,b,c\n1,2,3");
  });

  it("throws with status + body on a non-401 error", async () => {
    apiResponses = [{ status: 500, body: "boom" }];
    await expect(client().request("GET", "/api-op/v1/databases")).rejects.toThrow(
      /failed: 500.*boom/,
    );
  });
});
