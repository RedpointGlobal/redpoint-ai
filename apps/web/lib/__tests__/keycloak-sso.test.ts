/**
 * SSO (Keycloak) password-grant helpers — deterministic unit tests.
 *
 * The crux (homie's spec): the provider must POST grant_type=password with
 * client_id=rpi and NO client_secret to the DISCOVERED PUBLIC token endpoint
 * (derived from login-settings' openIDIssuer, NEVER the cluster-internal
 * `tokenEndpoint` field), and map the response into the rpi* session fields.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  discoverKeycloakSso,
  keycloakPasswordGrant,
  keycloakRefresh,
  keycloakOidcOptions,
  mapKeycloakOidcAccount,
} from "../keycloak-sso";

const realFetch = globalThis.fetch;
const savedEnv = {
  rpi: process.env.RPI_INTEGRATION_API_URL,
  issuer: process.env.KEYCLOAK_SSO_ISSUER,
  clientId: process.env.KEYCLOAK_SSO_CLIENT_ID,
};

// The PUBLIC realm issuer (login-settings.openIDIssuer) and the INTERNAL one we
// must NEVER use (login-settings.tokenEndpoint).
const PUBLIC_ISSUER = "https://public.example.test/auth/realms/example-realm";
const PUBLIC_TOKEN_ENDPOINT = `${PUBLIC_ISSUER}/protocol/openid-connect/token`;
// A cluster-internal host the login-settings `tokenEndpoint` field reports, which
// the discovery MUST ignore in favour of the public issuer above.
const INTERNAL_TOKEN_ENDPOINT = "http://keycloak.internal/auth/realms/example-realm/protocol/openid-connect/token";

/** login-settings body with a Keycloak OpenID entry (public issuer + internal token endpoint). */
function loginSettingsBody() {
  return JSON.stringify([
    { authenticationType: "Native", isExternal: false },
    {
      authenticationType: "OpenID",
      isExternal: true,
      clientID: "rpi",
      openIDIssuer: PUBLIC_ISSUER,
      tokenEndpoint: INTERNAL_TOKEN_ENDPOINT, // MUST be ignored
      audience: "example_audience",
      enableRefreshTokens: true,
    },
  ]);
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    access_token: "kc-access-token",
    token_type: "Bearer",
    expires_in: 300,
    refresh_token: "kc-refresh-token",
    scope: "openid",
    ...overrides,
  });
}

/** Records every token-endpoint POST so tests can assert on the wire form. */
let tokenPosts: Array<{ url: string; params: URLSearchParams }>;

function installFetch(opts: { loginSettingsOk?: boolean; tokenStatus?: number } = {}) {
  const { loginSettingsOk = true, tokenStatus = 200 } = opts;
  tokenPosts = [];
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/v2/authentication/login-settings")) {
      return loginSettingsOk
        ? new Response(loginSettingsBody(), { status: 200 })
        : new Response("nope", { status: 503 });
    }
    if (u.includes("/protocol/openid-connect/token")) {
      tokenPosts.push({
        url: u,
        params: new URLSearchParams(String(init?.body ?? "")),
      });
      return new Response(tokenResponse(), { status: tokenStatus });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.RPI_INTEGRATION_API_URL = "https://rpi.example.test";
  delete process.env.KEYCLOAK_SSO_ISSUER;
  delete process.env.KEYCLOAK_SSO_CLIENT_ID;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [
    ["RPI_INTEGRATION_API_URL", savedEnv.rpi],
    ["KEYCLOAK_SSO_ISSUER", savedEnv.issuer],
    ["KEYCLOAK_SSO_CLIENT_ID", savedEnv.clientId],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("discoverKeycloakSso", () => {
  it("derives the PUBLIC token endpoint from openIDIssuer + clientID (NEVER the internal tokenEndpoint)", async () => {
    installFetch();
    const cfg = await discoverKeycloakSso();
    expect(cfg).not.toBeNull();
    expect(cfg!.clientId).toBe("rpi");
    expect(cfg!.issuer).toBe(PUBLIC_ISSUER);
    expect(cfg!.tokenEndpoint).toBe(PUBLIC_TOKEN_ENDPOINT);
    // The cluster-internal endpoint must never leak through.
    expect(cfg!.tokenEndpoint).not.toBe(INTERNAL_TOKEN_ENDPOINT);
    expect(cfg!.tokenEndpoint).not.toContain("keycloak.internal");
  });

  it("falls back to KEYCLOAK_SSO_ISSUER/CLIENT_ID (public) when login-settings is unreachable", async () => {
    installFetch({ loginSettingsOk: false });
    process.env.KEYCLOAK_SSO_ISSUER = PUBLIC_ISSUER;
    process.env.KEYCLOAK_SSO_CLIENT_ID = "rpi";
    const cfg = await discoverKeycloakSso();
    expect(cfg).not.toBeNull();
    expect(cfg!.tokenEndpoint).toBe(PUBLIC_TOKEN_ENDPOINT);
    expect(cfg!.clientId).toBe("rpi");
  });

  it("returns null when neither discovery nor env yields a public issuer", async () => {
    installFetch({ loginSettingsOk: false });
    expect(await discoverKeycloakSso()).toBeNull();
  });
});

describe("keycloakPasswordGrant", () => {
  it("POSTs grant_type=password + client_id=rpi + scope=openid + NO client_secret to the discovered PUBLIC endpoint", async () => {
    installFetch();
    const session = await keycloakPasswordGrant("alice", "s3cret");
    expect(session).not.toBeNull();

    expect(tokenPosts).toHaveLength(1);
    const post = tokenPosts[0]!;
    expect(post.url).toBe(PUBLIC_TOKEN_ENDPOINT);
    expect(post.params.get("grant_type")).toBe("password");
    expect(post.params.get("client_id")).toBe("rpi");
    expect(post.params.get("scope")).toBe("openid");
    expect(post.params.get("username")).toBe("alice");
    expect(post.params.get("password")).toBe("s3cret");
    // PUBLIC client — a secret must never be sent.
    expect(post.params.has("client_secret")).toBe(false);
  });

  it("maps the token response into rpi* session fields", async () => {
    installFetch();
    const before = Date.now();
    const session = await keycloakPasswordGrant("alice", "s3cret");
    expect(session!.rpiAccessToken).toBe("kc-access-token");
    expect(session!.rpiRefreshToken).toBe("kc-refresh-token");
    // expires_in 300s → ~+300000ms from now.
    expect(session!.rpiExpiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(session!.rpiExpiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("returns null when the grant is rejected (bad credentials)", async () => {
    installFetch({ tokenStatus: 401 });
    expect(await keycloakPasswordGrant("alice", "wrong")).toBeNull();
  });
});

describe("keycloakOidcOptions (redirect flow — authorization_code + PKCE)", () => {
  it("configures a PUBLIC client: PKCE + state, NO client secret, discovered issuer/clientId", () => {
    const opts = keycloakOidcOptions(PUBLIC_ISSUER, "rpi");
    expect(opts.clientId).toBe("rpi");
    expect(opts.issuer).toBe(PUBLIC_ISSUER);
    // Public client — token endpoint auth method "none" (no secret sent).
    expect(opts.client.token_endpoint_auth_method).toBe("none");
    // PKCE is the whole point of a public-client redirect flow.
    expect(opts.checks).toContain("pkce");
    expect(opts.checks).toContain("state");
    // No secret anywhere in the options.
    expect(JSON.stringify(opts)).not.toContain("secret");
    expect(opts.authorization.params.scope).toContain("openid");
  });

  it("normalises a trailing slash on the issuer", () => {
    const opts = keycloakOidcOptions(`${PUBLIC_ISSUER}/`, "rpi");
    expect(opts.issuer).toBe(PUBLIC_ISSUER);
  });
});

describe("mapKeycloakOidcAccount (redirect token → rpi* session)", () => {
  it("maps access/refresh tokens and converts expires_at seconds → ms", () => {
    const nowSec = 1_000_000_000;
    const mapped = mapKeycloakOidcAccount({
      access_token: "oidc-access",
      refresh_token: "oidc-refresh",
      expires_at: nowSec,
    });
    expect(mapped).not.toBeNull();
    expect(mapped!.rpiAccessToken).toBe("oidc-access");
    expect(mapped!.rpiRefreshToken).toBe("oidc-refresh");
    expect(mapped!.rpiExpiresAt).toBe(nowSec * 1000);
  });

  it("returns null when there is no access token", () => {
    expect(mapKeycloakOidcAccount({ refresh_token: "x" })).toBeNull();
    expect(mapKeycloakOidcAccount(null)).toBeNull();
    expect(mapKeycloakOidcAccount(undefined)).toBeNull();
  });

  it("falls back to a near-term expiry when expires_at is absent", () => {
    const before = Date.now();
    const mapped = mapKeycloakOidcAccount({ access_token: "a" });
    expect(mapped!.rpiExpiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(mapped!.rpiExpiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe("keycloakRefresh", () => {
  it("POSTs grant_type=refresh_token + client_id=rpi + NO client_secret to the PUBLIC endpoint", async () => {
    installFetch();
    const session = await keycloakRefresh("kc-refresh-token");
    expect(session).not.toBeNull();
    expect(tokenPosts).toHaveLength(1);
    const post = tokenPosts[0]!;
    expect(post.url).toBe(PUBLIC_TOKEN_ENDPOINT);
    expect(post.params.get("grant_type")).toBe("refresh_token");
    expect(post.params.get("refresh_token")).toBe("kc-refresh-token");
    expect(post.params.get("client_id")).toBe("rpi");
    expect(post.params.has("client_secret")).toBe(false);
  });
});
