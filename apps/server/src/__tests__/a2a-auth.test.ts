/**
 * A2A inbound auth: explicit mode (A2A_AUTH_MODE oidc|bearer, no default, no
 * fallback), fail-closed oidc discovery, per-user verification BEFORE the JSON-RPC
 * handler (local JWT first, RPI validation when that fails — service identities
 * refused on both paths), the read-only userBuilder, and the agent card per mode.
 *
 * The oidc tests use the REAL mirrored verifier (createOidcVerifier) against a
 * JWKS served on an ephemeral port, with tokens signed here by jose.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import express from "express";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import type { AddressInfo } from "node:net";
import {
  isServiceIdentity,
  oidcUserBuilder,
  prepareA2AAuth,
  requireOidcUser,
  resolveA2AAuthMode,
  rpiUserIdentitySource,
  userIdentityOf,
  A2AVerifiedUser,
  type UserIdentity,
} from "../a2a/auth.js";
import { requireBearer } from "../a2a/server.js";
import { buildAgentCard } from "../a2a/agent-card.js";
import { createOidcVerifier } from "../auth/oidc-discovery.js";

const ISSUER = "https://sso.example.test/auth/realms/test-realm";
const AUDIENCE = "test-audience";
const PROXY_USER = "svc-proxy";

describe("A2A_AUTH_MODE — explicit, no default, no fallback", () => {
  it("not set → error (the server is not started)", () => {
    expect(resolveA2AAuthMode({})).toEqual({ error: 'A2A_AUTH_MODE is not set (use "oidc" or "bearer")' });
  });
  it("an unknown value → error", () => {
    expect(resolveA2AAuthMode({ A2A_AUTH_MODE: "none" })).toEqual({
      error: 'A2A_AUTH_MODE="none" is not valid (use "oidc" or "bearer")',
    });
  });
  it("bearer without A2A_BEARER_TOKEN → error; with it → bearer", () => {
    expect(resolveA2AAuthMode({ A2A_AUTH_MODE: "bearer" })).toEqual({
      error: "A2A_AUTH_MODE=bearer but A2A_BEARER_TOKEN is not set",
    });
    expect(resolveA2AAuthMode({ A2A_AUTH_MODE: "bearer", A2A_BEARER_TOKEN: "t" })).toEqual({
      mode: "bearer",
      bearerToken: "t",
    });
  });
  it("oidc without RPI_INTEGRATION_API_URL → error; with it → oidc on the API base", () => {
    expect(resolveA2AAuthMode({ A2A_AUTH_MODE: "oidc" })).toEqual({
      error: "A2A_AUTH_MODE=oidc but RPI_INTEGRATION_API_URL is not set",
    });
    expect(resolveA2AAuthMode({ A2A_AUTH_MODE: "oidc", RPI_INTEGRATION_API_URL: "https://rpi.example.test/api/v2/" })).toEqual({
      mode: "oidc",
      rpiBaseUrl: "https://rpi.example.test",
    });
  });
  it("a bearer token present does NOT make oidc fall back to bearer", async () => {
    const r = await prepareA2AAuth(
      { A2A_AUTH_MODE: "oidc", RPI_INTEGRATION_API_URL: "https://rpi.example.test", A2A_BEARER_TOKEN: "t" },
      { discover: async () => null },
    );
    expect(r).toEqual({ error: "A2A_AUTH_MODE=oidc but OIDC discovery found no OpenID provider" });
  });
});

describe("prepareA2AAuth", () => {
  it("oidc: discovery failure → fail-closed error", async () => {
    const r = await prepareA2AAuth(
      { A2A_AUTH_MODE: "oidc", RPI_INTEGRATION_API_URL: "https://rpi.example.test" },
      { discover: async () => null },
    );
    expect("error" in r).toBe(true);
  });
  it("oidc: discovery reads login-settings from the RPI base, then builds the verifier", async () => {
    let calledWith: unknown = null;
    const config = { issuer: ISSUER, jwksUri: "https://sso.example.test/certs", audience: AUDIENCE };
    const r = await prepareA2AAuth(
      { A2A_AUTH_MODE: "oidc", RPI_INTEGRATION_API_URL: "https://rpi.example.test/api/v2" },
      {
        discover: async (source) => {
          calledWith = source;
          return config;
        },
        createVerifier: (c) => ({ config: c, verifyToken: async () => ({ valid: false }) }),
        validateRpiToken: async () => null,
      },
    );
    expect(typeof (calledWith as { getLoginSettings?: unknown }).getLoginSettings).toBe("function");
    expect("auth" in r && r.auth.mode).toBe("oidc");
    expect("auth" in r && r.auth.mode === "oidc" && r.auth.verifier.config).toEqual(config);
  });
  it("oidc: the RPI fallback uses the injected RPI validation; RPI_PROXY_USER is carried as the refused proxy user", async () => {
    const validated: string[] = [];
    const r = await prepareA2AAuth(
      { A2A_AUTH_MODE: "oidc", RPI_INTEGRATION_API_URL: "https://rpi.example.test/api/v2", RPI_PROXY_USER: " svc-proxy " },
      {
        discover: async () => ({ issuer: ISSUER, jwksUri: "https://sso.example.test/certs", audience: AUDIENCE }),
        createVerifier: (c) => ({ config: c, verifyToken: async () => ({ valid: false }) }),
        validateRpiToken: async (token, base) => (validated.push(`${base}|${token}`), null),
      },
    );
    if (!("auth" in r) || r.auth.mode !== "oidc") throw new Error("expected oidc auth");
    expect(r.auth.proxyUser).toBe("svc-proxy");
    expect(await r.auth.rpiIdentity.resolve("tok")).toBeNull();
    expect(validated).toEqual(["https://rpi.example.test|tok"]);
  });
  it("bearer: passes straight through", async () => {
    expect(await prepareA2AAuth({ A2A_AUTH_MODE: "bearer", A2A_BEARER_TOKEN: "t" })).toEqual({
      auth: { mode: "bearer", bearerToken: "t" },
    });
  });
});

describe("userIdentityOf / isServiceIdentity", () => {
  it("a user token → sub + username; an app-only / service-account token → null", () => {
    expect(userIdentityOf({ sub: "u1", preferred_username: "alice" })).toEqual({ sub: "u1", username: "alice" });
    expect(userIdentityOf({ sub: "s1", preferred_username: "service-account-reports" })).toBeNull();
    expect(userIdentityOf({ sub: "s1" })).toBeNull();
    expect(userIdentityOf({ preferred_username: "alice" })).toBeNull();
  });
  it("the configured proxy user is a service identity (case-insensitive); other users are not", () => {
    expect(userIdentityOf({ sub: "p1", preferred_username: "SVC-Proxy" }, PROXY_USER)).toBeNull();
    expect(userIdentityOf({ sub: "u1", preferred_username: "alice" }, PROXY_USER)).toEqual({ sub: "u1", username: "alice" });
    expect(isServiceIdentity("svc-proxy", PROXY_USER)).toBe(true);
    expect(isServiceIdentity("service-account-x")).toBe(true);
    expect(isServiceIdentity("alice", PROXY_USER)).toBe(false);
    expect(isServiceIdentity("svc-proxy")).toBe(false);
  });
});

describe("rpiUserIdentitySource — RPI validates; realm token binds its username by sub, a native token uses user-profile", () => {
  const BASE = "https://rpi.example.test";
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const profile = (status: number, body: unknown) =>
    (async (url: string, init: RequestInit) => {
      profileCalls.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  let profileCalls: Array<{ url: string; auth: string | null }> = [];
  const valid = async () => ID;
  // An unsigned JWT-shaped token (RPI does the validating; the source only decodes it).
  const jwt = (claims: Record<string, unknown>) =>
    [{ alg: "RS256" }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".sig";
  const noProfile = (async () => {
    throw new Error("user-profile must not be called for a realm token");
  }) as unknown as typeof fetch;
  it("a realm token whose sub == RPI's validated id → { stable id, its preferred_username }; user-profile NOT called", async () => {
    const tok = jwt({ iss: `${ISSUER}/`, sub: ID.toUpperCase(), preferred_username: " alice " });
    expect(await rpiUserIdentitySource(BASE, ISSUER, valid, noProfile).resolve(tok)).toEqual({ sub: ID, username: "alice" });
  });
  const REALM_NULLS: Array<[string, Record<string, unknown>]> = [
    ["sub ≠ RPI's validated id", { iss: ISSUER, sub: "11111111-2222-3333-4444-555555555555", preferred_username: "alice" }],
    ["no sub", { iss: ISSUER, preferred_username: "alice" }],
    ["blank preferred_username", { iss: ISSUER, sub: ID, preferred_username: "  " }],
    ["no preferred_username", { iss: ISSUER, sub: ID }],
  ];
  for (const [label, claims] of REALM_NULLS)
    it(`a realm token with ${label} → null`, async () => {
      expect(await rpiUserIdentitySource(BASE, ISSUER, valid, noProfile).resolve(jwt(claims))).toBeNull();
    });
  it("a native RPI token (a JWT from ANOTHER issuer, no preferred_username) → the user-profile path", async () => {
    profileCalls = [];
    const tok = jwt({ iss: "https://rpi.example.test/identity", sub: ID, name: "bob" });
    const src = rpiUserIdentitySource(BASE, ISSUER, valid, profile(200, { id: ID, username: "bob" }));
    expect(await src.resolve(tok)).toEqual({ sub: ID, username: "bob" });
    expect(profileCalls).toHaveLength(1);
  });
  it("a native (non-JWT) token RPI validates + matching profile → { sub: stable id, username }", async () => {
    profileCalls = [];
    const src = rpiUserIdentitySource(BASE, ISSUER, valid, profile(200, { id: ID.toUpperCase(), username: " alice " }));
    expect(await src.resolve("tok")).toEqual({ sub: ID, username: "alice" });
    expect(profileCalls).toEqual([{ url: `${BASE}/api/v2/authentication/user-profile`, auth: "Bearer tok" }]);
  });
  it("RPI rejects the token → null, the profile is never fetched", async () => {
    profileCalls = [];
    expect(await rpiUserIdentitySource(BASE, ISSUER, async () => null, profile(200, { id: ID, username: "alice" })).resolve("tok")).toBeNull();
    expect(profileCalls).toHaveLength(0);
  });
  const NULLS: Array<[string, typeof fetch]> = [
    ["the profile call fails", profile(401, {})],
    ["the profile names a different user id", profile(200, { id: "11111111-2222-3333-4444-555555555555", username: "alice" })],
    ["the profile has no username", profile(200, { id: ID, username: "  " })],
    ["RPI is unreachable", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch],
  ];
  for (const [label, fetchImpl] of NULLS)
    it(`${label} → null`, async () => {
      expect(await rpiUserIdentitySource(BASE, ISSUER, valid, fetchImpl).resolve("tok")).toBeNull();
    });
});

describe("requireOidcUser — verified BEFORE any handler runs", () => {
  let jwksServer: ReturnType<typeof Bun.serve>;
  let appServer: ReturnType<ReturnType<typeof express>["listen"]>;
  let appUrl = "";
  let signingKey: CryptoKey;
  let otherKey: CryptoKey;
  const handled: Array<{ user: A2AVerifiedUser | null }> = [];
  // The RPI half of the two-step: what RPI resolves each token to (absent = RPI rejects it).
  const rpiUsers = new Map<string, UserIdentity>();
  const rpiCalls: string[] = [];
  const rpiIdentity = {
    resolve: async (token: string) => (rpiCalls.push(token), rpiUsers.get(token) ?? null),
  };

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    signingKey = pair.privateKey as CryptoKey;
    otherKey = (await generateKeyPair("RS256")).privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JWK;
    jwksServer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
    const verifier = createOidcVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: `http://localhost:${jwksServer.port}/certs`,
    });
    const app = express();
    app.use(express.json());
    app.get("/.well-known/agent-card.json", (_req, res) => res.json({ card: true }));
    app.use("/", requireOidcUser({ verifier, rpiIdentity, proxyUser: PROXY_USER }), async (req, res) => {
      const user = await oidcUserBuilder(req);
      handled.push({ user: user instanceof A2AVerifiedUser ? user : null });
      res.json({ ok: true, isAuthenticated: user.isAuthenticated, userName: user.userName });
    });
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, () => resolve());
    });
    appUrl = `http://localhost:${(appServer.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    appServer?.close();
    jwksServer?.stop(true);
  });

  const sign = (claims: Record<string, unknown>, opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: number | string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(opts.key ?? signingKey);
  const post = (token?: string) =>
    fetch(appUrl + "/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
    });

  const reset = () => {
    handled.length = 0;
    rpiCalls.length = 0;
    rpiUsers.clear();
  };

  it("a valid user JWT → the handler runs with the verified user (sub, username, token); RPI is not called", async () => {
    reset();
    const token = await sign({ sub: "user-123", preferred_username: "alice" });
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, isAuthenticated: true, userName: "alice" });
    expect(handled).toHaveLength(1);
    expect(handled[0]!.user).toMatchObject({ sub: "user-123", username: "alice", token });
    expect(rpiCalls).toHaveLength(0);
  });

  it("JWT verify fails (e.g. another audience) but RPI accepts the token → the handler runs with RPI's identity", async () => {
    reset();
    const token = await sign({ sub: "kc-sub", preferred_username: "alice" }, { aud: "account" });
    rpiUsers.set(token, { sub: "rpi-guid-1", username: "alice@example.test" });
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, isAuthenticated: true, userName: "alice@example.test" });
    expect(handled[0]!.user).toMatchObject({ sub: "rpi-guid-1", username: "alice@example.test", token });
    expect(rpiCalls).toEqual([token]);
  });

  it("a non-JWT token RPI accepts (a native RPI token) → the handler runs with RPI's identity", async () => {
    reset();
    rpiUsers.set("native-rpi-token", { sub: "rpi-guid-2", username: "bob" });
    const res = await post("native-rpi-token");
    expect(res.status).toBe(200);
    expect(handled[0]!.user).toMatchObject({ sub: "rpi-guid-2", username: "bob", token: "native-rpi-token" });
  });

  it("RPI accepts the token but it is the proxy user / a service account → 401 no user identity, the handler never runs", async () => {
    for (const username of ["svc-proxy", "SVC-PROXY", "service-account-reports"]) {
      reset();
      rpiUsers.set("svc-token", { sub: "rpi-guid-svc", username });
      const res = await post("svc-token");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized: the token has no user identity" },
        id: null,
      });
      expect(handled).toHaveLength(0);
    }
  });

  const REJECTS: Array<[string, () => Promise<string | undefined>, string]> = [
    ["no token", async () => undefined, "Unauthorized: missing Bearer token"],
    ["a bad signature", () => sign({ sub: "u", preferred_username: "alice" }, { key: otherKey }), "Unauthorized: invalid or expired token"],
    ["the wrong issuer", () => sign({ sub: "u", preferred_username: "alice" }, { iss: "https://evil.example.test" }), "Unauthorized: invalid or expired token"],
    ["the wrong audience", () => sign({ sub: "u", preferred_username: "alice" }, { aud: "someone-else" }), "Unauthorized: invalid or expired token"],
    ["an expired token", () => sign({ sub: "u", preferred_username: "alice" }, { exp: Math.floor(Date.now() / 1000) - 120 }), "Unauthorized: invalid or expired token"],
    ["an app-only (service-account) token", () => sign({ sub: "s1", preferred_username: "service-account-reports" }), "Unauthorized: the token has no user identity"],
    ["a valid JWT for the proxy user", () => sign({ sub: "p1", preferred_username: "svc-proxy" }), "Unauthorized: the token has no user identity"],
    ["a token with no username", () => sign({ sub: "s1" }), "Unauthorized: the token has no user identity"],
  ];
  for (const [label, makeToken, message] of REJECTS)
    it(`${label} → 401 JSON-RPC -32000 "${message}", the handler never runs`, async () => {
      reset(); // RPI accepts none of these tokens
      const res = await post(await makeToken());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
      expect(handled).toHaveLength(0);
    });

  it("the agent card stays public", async () => {
    const res = await fetch(appUrl + "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
  });

  it("the userBuilder never throws — with nothing attached it returns an unauthenticated user", async () => {
    const user = await oidcUserBuilder({} as never);
    expect(user.isAuthenticated).toBe(false);
  });
});

describe("bearer mode — unchanged", () => {
  it("a wrong token gets the SAME 401 body as before (code -32001)", () => {
    let status = 0;
    let body: unknown = null;
    const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as never;
    let nextCalled = false;
    requireBearer("right")({ path: "/", header: () => "Bearer wrong" } as never, res, () => (nextCalled = true));
    expect(status).toBe(401);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid Bearer token" },
      id: null,
    });
    expect(nextCalled).toBe(false);
  });
  it("the right token passes", () => {
    let nextCalled = false;
    requireBearer("right")({ path: "/", header: () => "Bearer right" } as never, {} as never, () => (nextCalled = true));
    expect(nextCalled).toBe(true);
  });
});

describe("agent card per mode", () => {
  it("bearer (default) → http bearer scheme, unchanged", () => {
    const card = buildAgentCard({ skills: [], baseUrl: "http://localhost:4100" });
    expect(card.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } });
    expect(card.security).toEqual([{ bearer: [] }]);
  });
  it("oidc → openIdConnect pointing at the issuer's discovery document", () => {
    const card = buildAgentCard({ skills: [], baseUrl: "http://localhost:4100", auth: { mode: "oidc", issuer: `${ISSUER}/` } });
    expect(card.securitySchemes).toEqual({
      oidc: { type: "openIdConnect", openIdConnectUrl: `${ISSUER}/.well-known/openid-configuration` },
    });
    expect(card.security).toEqual([{ oidc: [] }]);
  });
});
