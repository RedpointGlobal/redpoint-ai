/**
 * Tenant pinning (DRHApiClient, pinClientId): with the pin ON (the hardened
 * container compiles DRH_PIN_CLIENT_ID="true" in), only the configured tenant is
 * ever sent, and a per-call clientId that differs is rejected before any request —
 * one container per tenant. OFF (the default) leaves the per-call override working.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DRHAuthService } from "../drh-auth.js";
import { DRHApiClient } from "../drh-api.js";

const BASE = "https://drh.example.test";
const realFetch = globalThis.fetch;
let calls: string[];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("/auth/signon")) return new Response(JSON.stringify({ accessToken: "proxy-1" }), { status: 200 });
    const h = (init?.headers || {}) as Record<string, string>;
    return new Response(JSON.stringify({ sent: h["X-ClientId"] }), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => void (globalThis.fetch = realFetch));

function client(pin: boolean, def = "the-tenant") {
  return new DRHApiClient(BASE, new DRHAuthService(BASE, "svc", "pw", 300), def, undefined, pin);
}

describe("tenant pinning", () => {
  it("pinned: no clientId → the default tenant is sent", async () => {
    expect(await client(true).request("GET", "/api-op/v1/databases")).toEqual({ sent: "the-tenant" });
  });
  it("pinned: the same clientId (any case/space) → allowed, the default sent", async () => {
    expect(await client(true).request("GET", "/api-op/v1/databases", { clientId: "  THE-TENANT " })).toEqual({ sent: "the-tenant" });
  });
  it("pinned: a different clientId → rejected before any request", async () => {
    await expect(client(true).request("GET", "/api-op/v1/databases", { clientId: "other-tenant" })).rejects.toThrow(/pinned to its configured tenant \(DRH_PIN_CLIENT_ID\)/);
    expect(calls).toEqual([]); // nothing was sent, not even a signon
  });
  it("unpinned (default): a per-call override is honored", async () => {
    expect(await client(false).request("GET", "/api-op/v1/databases", { clientId: "other-tenant" })).toEqual({ sent: "other-tenant" });
  });
});
