/**
 * Login-only mode: AUTH_REQUIRED=true with the proxy user off. Every RPI call then
 * carries the caller's own token, so the RPI OAuth client (RPI_OAUTH_CLIENT_ID /
 * RPI_OAUTH_CLIENT_SECRET) is not required at boot; a path that would mint a token
 * with it fails with a named error and never sends a request. Everything else —
 * auth off, the proxy enabled, an invalid proxy config — keeps the full
 * requirements, unchanged.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { isLoginOnly, missingRpiVarsIn, proxyOnlyBanner, RPIConfigSchema, RPILoginOnlyConfigSchema } from "../config.js";
import { RPIAuthService } from "../client/rpi-auth.js";

const BASE = { RPI_INTEGRATION_API_URL: "https://rpi.example.test", RPI_DEFAULT_CLIENT_ID: "tenant-1" };
const OAUTH = { RPI_OAUTH_CLIENT_ID: "cid", RPI_OAUTH_CLIENT_SECRET: "sec" };
const PROXY = { RPI_PROXY_USER: "svc", RPI_PROXY_PASS: "pw" };

describe("isLoginOnly", () => {
  it("auth required (or unset) + proxy off → login-only", () => {
    expect(isLoginOnly({ AUTH_REQUIRED: "true", RPI_PROXY_ENABLED: "false", ...PROXY })).toBe(true);
    expect(isLoginOnly({ AUTH_REQUIRED: "true" })).toBe(true);
    expect(isLoginOnly({})).toBe(true);
  });
  it("auth off, the proxy on, or an invalid proxy config → not login-only", () => {
    expect(isLoginOnly({ AUTH_REQUIRED: "false" })).toBe(false);
    expect(isLoginOnly({ AUTH_REQUIRED: "true", ...PROXY })).toBe(false);
    expect(isLoginOnly({ AUTH_REQUIRED: "true", RPI_PROXY_ENABLED: "true" })).toBe(false);
  });
});

describe("missingRpiVarsIn — what the HTTP server needs", () => {
  it("outside login-only: the URL and the OAuth client, in the same order (a default tenant is optional)", () => {
    const all = ["RPI_INTEGRATION_API_URL", "RPI_OAUTH_CLIENT_ID", "RPI_OAUTH_CLIENT_SECRET"];
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "false" })).toEqual(all);
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "true", ...PROXY })).toEqual(all);
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "true", RPI_PROXY_ENABLED: "true" })).toEqual(all);
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "false", ...BASE })).toEqual(["RPI_OAUTH_CLIENT_ID", "RPI_OAUTH_CLIENT_SECRET"]);
    // The native-login path with no default tenant (a native-login test setup): nothing missing.
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "false", RPI_PROXY_ENABLED: "true", RPI_INTEGRATION_API_URL: "https://rpi.example.test", RPI_DEFAULT_CLIENT_ID: "", ...OAUTH, ...PROXY })).toEqual([]);
  });
  it("login-only: neither the OAuth client nor a default tenant is required; the URL still is", () => {
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "true", RPI_PROXY_ENABLED: "false", ...BASE })).toEqual([]);
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "true", ...BASE })).toEqual([]);
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "true", RPI_PROXY_ENABLED: "false" })).toEqual(["RPI_INTEGRATION_API_URL"]);
    expect(missingRpiVarsIn({ AUTH_REQUIRED: "true", RPI_INTEGRATION_API_URL: "https://rpi.example.test" })).toEqual([]);
  });
});

describe("config schemas", () => {
  const cfg = { integrationApiUrl: "https://rpi.example.test", proxyEnabled: false, defaultClientId: "tenant-1", authRequired: true };
  it("the full schema still requires the OAuth client", () => {
    expect(RPIConfigSchema.safeParse(cfg).success).toBe(false);
    expect(RPIConfigSchema.safeParse({ ...cfg, oauthClientId: "cid", oauthClientSecret: "sec" }).success).toBe(true);
  });
  it("the full schema takes the default tenant absent or empty (unset)", () => {
    const full = { ...cfg, oauthClientId: "cid", oauthClientSecret: "sec" };
    const empty = RPIConfigSchema.safeParse({ ...full, defaultClientId: "" });
    expect(empty.success && empty.data.defaultClientId).toBeUndefined();
    const { defaultClientId: _, ...absent } = full;
    expect(RPIConfigSchema.safeParse(absent).success).toBe(true);
  });
  it("the login-only schema accepts the OAuth pair and the default tenant absent or empty (pinned empty), and keeps the proxy rule", () => {
    expect(RPILoginOnlyConfigSchema.safeParse(cfg).success).toBe(true);
    const noTenant = RPILoginOnlyConfigSchema.safeParse({ ...cfg, defaultClientId: "" });
    expect(noTenant.success && noTenant.data.defaultClientId).toBeUndefined();
    const pinnedEmpty = RPILoginOnlyConfigSchema.safeParse({ ...cfg, oauthClientId: "", oauthClientSecret: "" });
    expect(pinnedEmpty.success && [pinnedEmpty.data.oauthClientId, pinnedEmpty.data.oauthClientSecret]).toEqual([undefined, undefined]);
    expect(RPILoginOnlyConfigSchema.safeParse({ ...cfg, proxyEnabled: true }).success).toBe(false);
  });
});

describe("RPIAuthService without the OAuth client", () => {
  const realFetch = globalThis.fetch;
  let bodies: string[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    bodies = [];
  });
  const capture = () => {
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
  };
  const named = (what: string) =>
    `RPI_OAUTH_CLIENT_ID / RPI_OAUTH_CLIENT_SECRET are not set — ${what} is unavailable (login-only mode: every call must carry the caller's own RPI token).`;

  it("native login, token refresh and a proxy token each fail by name — no request sent", async () => {
    capture();
    const svc = new RPIAuthService("https://rpi.example.test", undefined, undefined, "svc", "pw");
    await expect(svc.loginUser("u", "p")).rejects.toThrow(named("native password login"));
    await expect(svc.refreshUserToken("r")).rejects.toThrow(named("token refresh"));
    await expect(svc.getProxyToken()).rejects.toThrow(named("the proxy user's token"));
    expect(bodies).toEqual([]);
  });
  it("with the OAuth client, the token request body is unchanged (field order included)", async () => {
    capture();
    await new RPIAuthService("https://rpi.example.test", "cid", "sec").loginUser("u", "p");
    expect(bodies).toEqual(["grant_type=password&username=u&password=p&client_id=cid&client_secret=sec"]);
  });
});

describe("proxyOnlyBanner — no per-user auth, every call as the proxy user", () => {
  it("auth off + proxy on → the loud line naming the user", () => {
    expect(proxyOnlyBanner(false, true, "svc")).toBe(
      "NATIVE RPI CREDENTIALS MODE (testing) — no SSO; every call runs as RPI user svc; not for customer deployments",
    );
  });
  it("auth required, or no proxy → none", () => {
    expect(proxyOnlyBanner(true, true, "svc")).toBeNull();
    expect(proxyOnlyBanner(false, false, undefined)).toBeNull();
    expect(proxyOnlyBanner(true, false, undefined)).toBeNull();
  });
});
