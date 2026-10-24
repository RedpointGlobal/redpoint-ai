/**
 * Tenant-less calls: a login-only deployment carries no default tenant, so a call
 * with no clientId goes WITHOUT X-ClientID only to the pinned client-agnostic
 * endpoints (the caller's tenants, login settings, token status, profile, the
 * instance version); any other path without a tenant fails by name. With a
 * default tenant (retail) the header is sent on every path, exactly as before.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { RPIApiClient, isClientAgnosticPath } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";

const BASE = "https://rpi.example.test";
const realFetch = globalThis.fetch;
let sent: Array<{ url: string; headers: Record<string, string> }> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  sent = [];
});
function capture() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
const client = (defaultClientId: string | undefined) => new RPIApiClient(BASE, new RPIAuthService(BASE, undefined, undefined), defaultClientId);

describe("isClientAgnosticPath", () => {
  it("the pinned allowlist only", () => {
    for (const p of [
      "/authentication/user-client-list",
      "/authentication/login-settings",
      "/authentication/validate-token-status",
      "/authentication/user-profile",
      "/info/version",
      "/api/v2/info/version",
      "/cluster/operations/system-health/availability",
      "/cluster/operations/logs/error/api",
      "/cluster/operations/logs/audit-history",
    ])
      expect(isClientAgnosticPath(p)).toBe(true);
    for (const p of ["/audiences", "/files/folders", "/info", "/admin/authentication/x", "/clients", "/clusters", "/api/v2/cluster"]) expect(isClientAgnosticPath(p)).toBe(false);
  });
});

describe("RPIApiClient without a default tenant (login-only)", () => {
  it("a client-agnostic path without a clientId → sent without X-ClientID", async () => {
    capture();
    await client(undefined).get("user-tok", "/authentication/user-client-list", undefined, { baseUrl: undefined });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.Authorization).toBe("Bearer user-tok");
    expect(sent[0]!.headers["X-ClientID"]).toBeUndefined();
  });
  it("a cluster-wide path (system health, the cluster logs) without a clientId → sent without X-ClientID", async () => {
    capture();
    await client(undefined).get("user-tok", "/cluster/operations/system-health/availability", undefined, { baseUrl: undefined });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["X-ClientID"]).toBeUndefined();
  });
  it("a tenant-scoped path without a clientId → the named error, nothing sent", async () => {
    capture();
    await expect(client(undefined).get("user-tok", "/audiences", undefined, { baseUrl: undefined })).rejects.toThrow(
      "RPI client ID not set. Pass `clientId` in the call or configure RPI_DEFAULT_CLIENT_ID.",
    );
    expect(sent).toHaveLength(0);
  });
  it("any path WITH a per-call clientId → the header, as always", async () => {
    capture();
    await client(undefined).get("user-tok", "/authentication/user-client-list", undefined, { baseUrl: undefined, clientId: "t-1" });
    await client(undefined).get("user-tok", "/audiences", undefined, { baseUrl: undefined, clientId: "t-1" });
    expect(sent.map((s) => s.headers["X-ClientID"])).toEqual(["t-1", "t-1"]);
  });
});

describe("RPIApiClient with a default tenant (retail) — unchanged", () => {
  it("the default goes on every path, client-agnostic ones included", async () => {
    capture();
    await client("tenant-default").get("user-tok", "/authentication/user-client-list", undefined, { baseUrl: undefined });
    await client("tenant-default").get("user-tok", "/audiences", undefined, { baseUrl: undefined });
    expect(sent.map((s) => s.headers["X-ClientID"])).toEqual(["tenant-default", "tenant-default"]);
  });
});

describe("every registered tool can reach its endpoints without an injected tenant (schema guard)", () => {
  it("a tool with no clientId parameter only calls client-agnostic endpoints", async () => {
    const { createRPIMcpServer } = await import("../server.js");
    const stubAuth = { proxyEnabled: false, getProxyToken: async () => "", validateToken: async () => false, getLoginSettings: async () => [] };
    const { server } = createRPIMcpServer(
      { integrationApiUrl: "http://localhost:9", defaultClientId: undefined } as never,
      stubAuth as never,
      null,
      null,
    );
    const registered = (
      server as unknown as {
        _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> }; _meta?: { endpoints?: string[] } }>;
      }
    )._registeredTools;
    // A client delivers the tenant as the clientId argument; a tool without
    // that parameter never receives it, so it must only call endpoints that need none.
    const noClientId = Object.entries(registered).filter(([, t]) => !t.inputSchema?.shape?.clientId);
    expect(noClientId.length).toBeGreaterThan(0);
    const scoped = noClientId.flatMap(([name, t]) => (t._meta?.endpoints ?? []).filter((e) => !isClientAgnosticPath(e)).map((e) => `${name} → ${e}`));
    expect(scoped).toEqual([]);
  });
});
