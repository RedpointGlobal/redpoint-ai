/**
 * Phase 1a — per-request RPI target URL ("Environment Location").
 *
 * The client must route each call to the per-request base URL passed on
 * RequestOptions.baseUrl (threaded from a validated X-RPI-URL → authInfo.targetUrl),
 * falling back to the construction-time default ONLY when no override is given.
 * This is the core data-integrity guarantee: request-with-URL-A hits location A,
 * URL-B hits B, same running client — no shared/global location.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { RPIApiClient } from "../client/rpi-api.js";
import type { RPIAuthService } from "../client/rpi-auth.js";

const DEFAULT = "https://default.example.test";
const LOC_A = "https://loc-a.example.test";
const LOC_B = "https://loc-b.example.test";

const origFetch = globalThis.fetch;
let lastUrl = "";
function stubFetch() {
  lastUrl = "";
  globalThis.fetch = mock(async (url: string | URL) => {
    lastUrl = String(url);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = origFetch;
});

// get() never touches authService (buildHeaders uses the passed token), so a
// cast stub is sufficient for a focused URL-routing test.
function makeClient() {
  return new RPIApiClient(DEFAULT, {} as RPIAuthService, "default-client");
}

describe("RPIApiClient — per-request Environment Location (baseUrl override)", () => {
  it("routes to the per-request override — location A", async () => {
    stubFetch();
    await makeClient().get("tok", "/audiences", undefined, { baseUrl: LOC_A });
    expect(lastUrl.startsWith(`${LOC_A}/api/v2/audiences`)).toBe(true);
  });

  it("routes a DIFFERENT override to location B — same client instance", async () => {
    stubFetch();
    await makeClient().get("tok", "/audiences", undefined, { baseUrl: LOC_B });
    expect(lastUrl.startsWith(`${LOC_B}/api/v2/audiences`)).toBe(true);
  });

  it("falls back to the construction-time default when NO override (no-URL path)", async () => {
    stubFetch();
    await makeClient().get("tok", "/audiences");
    expect(lastUrl.startsWith(`${DEFAULT}/api/v2/audiences`)).toBe(true);
  });

  it("A and B never bleed: two calls, two locations, one client", async () => {
    stubFetch();
    const client = makeClient();
    await client.get("tok", "/x", undefined, { baseUrl: LOC_A });
    const a = lastUrl;
    await client.get("tok", "/x", undefined, { baseUrl: LOC_B });
    const b = lastUrl;
    expect(a.startsWith(LOC_A)).toBe(true);
    expect(b.startsWith(LOC_B)).toBe(true);
  });

  it("post honors the override too", async () => {
    stubFetch();
    await makeClient().post("tok", "/x", {}, { baseUrl: LOC_A });
    expect(lastUrl.startsWith(`${LOC_A}/api/v2/x`)).toBe(true);
  });
});
