/**
 * apps/server authMiddleware — Mechanism B: RPI-native web session support.
 *
 * Under AUTH_REQUIRED=true, an RPI-native web login carries the RPI user token
 * in X-RPI-Token and has NO rpai_ apiKey. The gate must accept it (validated via
 * RPI validate-token-status), evaluated BEFORE the Authorization early-401 so
 * it is not dead code — while staying fail-closed for missing/invalid creds.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { authMiddleware, hashApiKey } from "../middleware/auth.js";

// A stable RPI/Keycloak user GUID as validate-token-status returns it (top-level
// `id`). The metering-convergence fix keys the principal on THIS, not the token.
const STABLE_ID = "3bcdb189-1a2b-4c3d-9e8f-000000000001";
/** validate-token-status success body carrying the stable identity. */
function tokenStatusBody(id: string | null = STABLE_ID): string {
  return JSON.stringify(id === null ? {} : { id });
}

const realFetch = globalThis.fetch;
const origAuthRequired = process.env.AUTH_REQUIRED;
const origRpiUrl = process.env.RPI_INTEGRATION_API_URL;

function makeApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/probe", (c) => c.json({ ok: true, user: c.get("user") }));
  return app;
}

beforeEach(() => {
  process.env.AUTH_REQUIRED = "true";
  process.env.RPI_INTEGRATION_API_URL = "https://rpi.example.test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (origAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = origAuthRequired;
  if (origRpiUrl === undefined) delete process.env.RPI_INTEGRATION_API_URL;
  else process.env.RPI_INTEGRATION_API_URL = origRpiUrl;
});

describe("authMiddleware — Mechanism B (RPI-native X-RPI-Token)", () => {
  it("auth=true + valid X-RPI-Token (no apiKey) → 200, user id = rpi:<stable GUID>", async () => {
    globalThis.fetch = mock(async (url: string) => {
      expect(String(url)).toContain("/api/v2/authentication/validate-token-status");
      return new Response(tokenStatusBody(), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await makeApp().request("/probe", {
      headers: { "X-RPI-Token": "valid-rpi-token-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; type: string } };
    expect(body.user.type).toBe("rpi-user");
    // Keyed on the stable identity, not a token hash.
    expect(body.user.id).toBe(`rpi:${STABLE_ID}`);
  });

  it("auth=true + NO credentials → 401 (fail closed)", async () => {
    const res = await makeApp().request("/probe");
    expect(res.status).toBe(401);
  });

  it("auth=true + invalid/expired X-RPI-Token → 401 (fail closed)", async () => {
    globalThis.fetch = mock(
      async () => new Response("token expired", { status: 401 }),
    ) as unknown as typeof fetch;
    const res = await makeApp().request("/probe", {
      headers: { "X-RPI-Token": "bad-or-expired-token" },
    });
    expect(res.status).toBe(401);
  });

  it("auth=true + RPI unconfigured (no RPI_INTEGRATION_API_URL) → X-RPI-Token can't validate → 401", async () => {
    delete process.env.RPI_INTEGRATION_API_URL;
    // fetch must never be called when there's no base URL.
    globalThis.fetch = mock(async () => {
      throw new Error("fetch should not be called when RPI is unconfigured");
    }) as unknown as typeof fetch;
    const res = await makeApp().request("/probe", {
      headers: { "X-RPI-Token": "some-token" },
    });
    expect(res.status).toBe(401);
  });

  it("auth=true + X-RPI-Token but RPI validate call THROWS (RPI unreachable) → 401 (fail closed)", async () => {
    // The validate fetch rejecting must be caught → treated as invalid → 401,
    // never a 500 or an accidental pass. Security-relevant fail-closed branch.
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await makeApp().request("/probe", {
      headers: { "X-RPI-Token": "token-when-rpi-down" },
    });
    expect(res.status).toBe(401);
  });

  it("valid X-RPI-Token takes precedence over a present Authorization header", async () => {
    // X-RPI-Token is checked first; a valid one authorizes as rpi-user even when
    // an (unrelated) Authorization header is also present.
    globalThis.fetch = mock(
      async () => new Response(tokenStatusBody(), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await makeApp().request("/probe", {
      headers: {
        "X-RPI-Token": "valid-token",
        Authorization: "Bearer rpai_wouldbe401",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { type: string } };
    expect(body.user.type).toBe("rpi-user");
  });

  it("rpai_ / OIDC path unchanged: a non-rpai_, non-JWT Bearer (no X-RPI-Token) → 401", async () => {
    // OIDC is unconfigured in test → a non-rpai_ Bearer 401s exactly as before.
    const res = await makeApp().request("/probe", {
      headers: { Authorization: "Bearer not-a-real-credential" },
    });
    expect(res.status).toBe(401);
  });

  it("rpai_ path still runs: an unknown rpai_ key → 401 Invalid API key (branch unchanged)", async () => {
    const res = await makeApp().request("/probe", {
      headers: { Authorization: "Bearer rpai_deadbeefdeadbeef" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid API key");
  });

  it("validation is cached within the TTL (a polled endpoint doesn't re-hit RPI)", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return new Response(tokenStatusBody(), { status: 200 });
    }) as unknown as typeof fetch;
    const app = makeApp();
    await app.request("/probe", { headers: { "X-RPI-Token": "cache-token-xyz" } });
    await app.request("/probe", { headers: { "X-RPI-Token": "cache-token-xyz" } });
    expect(calls).toBe(1);
  });

  // ---- Metering-convergence guard: id keyed on IDENTITY, not the token ----
  //
  // The bug this fixes: user.id was `rpi:` + hash(X-RPI-Token). apps/web refreshes
  // / re-mints the rpiAccessToken ~hourly, so the SAME user got a NEW id every
  // refresh and usage fragmented across ids → not billable per-individual. The
  // fix derives the id from validate-token-status' stable top-level GUID. This is
  // the DETERMINISTIC proof (no LLM, no live flake): same identity via two
  // DIFFERENT token strings must collapse to ONE user.id.
  it("convergence: two DIFFERENT tokens, same RPI identity → IDENTICAL user.id (survives refresh)", async () => {
    // Mock returns the same stable id regardless of which token is presented —
    // modelling a token refresh: new token string, same underlying user.
    globalThis.fetch = mock(
      async () => new Response(tokenStatusBody(STABLE_ID), { status: 200 }),
    ) as unknown as typeof fetch;
    const app = makeApp();
    const idOf = async (tok: string) => {
      const res = await app.request("/probe", { headers: { "X-RPI-Token": tok } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { user: { id: string } }).user.id;
    };
    const idA = await idOf("token-before-refresh-aaaaaaaa");
    const idB = await idOf("token-after-refresh-bbbbbbbb");

    // Same identity → same principal, even though the tokens differ.
    expect(idA).toBe(idB);
    expect(idA).toBe(`rpi:${STABLE_ID}`);
    // And it is NOT a hash of either token (the old, fragmenting scheme).
    const oldStyle = async (tok: string) =>
      `rpi:${(await hashApiKey(tok)).slice(0, 12)}`;
    expect(idA).not.toBe(await oldStyle("token-before-refresh-aaaaaaaa"));
    expect(idB).not.toBe(await oldStyle("token-after-refresh-bbbbbbbb"));
  });

  it("fail-closed: valid token but validate-token-status returns NO id → 401 (never token-hashed)", async () => {
    // A validated token we cannot attribute to a stable identity is an auth
    // failure — the fix must NOT silently fall back to the token hash (which
    // would reintroduce the fragmentation).
    globalThis.fetch = mock(
      async () => new Response(tokenStatusBody(null), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await makeApp().request("/probe", {
      headers: { "X-RPI-Token": "valid-but-no-identity" },
    });
    expect(res.status).toBe(401);
  });

  it("fail-closed: empty-guid id (00000000-…) is treated as unresolved → 401", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          tokenStatusBody("00000000-0000-0000-0000-000000000000"),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const res = await makeApp().request("/probe", {
      headers: { "X-RPI-Token": "valid-but-empty-guid" },
    });
    expect(res.status).toBe(401);
  });

  it("GUID casing is normalised: UPPER and lower forms of one id converge", async () => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      // Return the id in the casing that mirrors the token, to prove the
      // middleware — not the mock — is what normalises.
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      const id = auth.includes("UPPER")
        ? STABLE_ID.toUpperCase()
        : STABLE_ID;
      return new Response(tokenStatusBody(id), { status: 200 });
    }) as unknown as typeof fetch;
    const app = makeApp();
    const idOf = async (tok: string) =>
      ((await (await app.request("/probe", { headers: { "X-RPI-Token": tok } })).json()) as {
        user: { id: string };
      }).user.id;
    expect(await idOf("tok-UPPER")).toBe(await idOf("tok-lower"));
  });

  it("auth=false (dev) → bypass unchanged (user dev-user)", async () => {
    process.env.AUTH_REQUIRED = "false";
    const res = await makeApp().request("/probe");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe("dev-user");
  });

  // ---- Phase 1a increment 5: per-request Environment Location (X-RPI-URL) ----
  describe("X-RPI-URL — apps/server entry (SSRF + per-request validation)", () => {
    const origAllow = process.env.RPI_URL_ALLOWLIST;
    beforeEach(() => { process.env.RPI_URL_ALLOWLIST = "example.com"; });
    afterEach(() => { if (origAllow === undefined) delete process.env.RPI_URL_ALLOWLIST; else process.env.RPI_URL_ALLOWLIST = origAllow; });
    it("allowlisted X-RPI-URL → token validated against THAT instance, user set", async () => {
      let hitUrl = "";
      globalThis.fetch = mock(async (url: string) => {
        hitUrl = String(url);
        return new Response(tokenStatusBody(), { status: 200 });
      }) as unknown as typeof fetch;
      const res = await makeApp().request("/probe", {
        headers: { "X-RPI-Token": "tok", "X-RPI-URL": "https://loc-a.example.com" },
      });
      expect(res.status).toBe(200);
      // Validated against the rep's instance, not the env default.
      expect(hitUrl).toContain("loc-a.example.com");
      expect(hitUrl).toContain("/api/v2/authentication/validate-token-status");
      const body = (await res.json()) as { user: { id: string } };
      expect(body.user.id).toBe(`rpi:${STABLE_ID}`);
    });

    it("SSRF: non-allowlisted X-RPI-URL → 400, RPI never contacted", async () => {
      let called = false;
      globalThis.fetch = mock(async () => {
        called = true;
        return new Response(tokenStatusBody(), { status: 200 });
      }) as unknown as typeof fetch;
      const res = await makeApp().request("/probe", {
        headers: { "X-RPI-Token": "tok", "X-RPI-URL": "https://evil.attacker.com" },
      });
      expect(res.status).toBe(400);
      expect(called).toBe(false);
    });

    it("SSRF: non-https X-RPI-URL → 400", async () => {
      globalThis.fetch = mock(
        async () => new Response(tokenStatusBody(), { status: 200 }),
      ) as unknown as typeof fetch;
      const res = await makeApp().request("/probe", {
        headers: { "X-RPI-Token": "tok", "X-RPI-URL": "http://loc-a.example.com" },
      });
      expect(res.status).toBe(400);
    });

    it("backward-compat: NO X-RPI-URL → validated against the env default instance", async () => {
      let hitUrl = "";
      globalThis.fetch = mock(async (url: string) => {
        hitUrl = String(url);
        return new Response(tokenStatusBody(), { status: 200 });
      }) as unknown as typeof fetch;
      const res = await makeApp().request("/probe", { headers: { "X-RPI-Token": "tok" } });
      expect(res.status).toBe(200);
      expect(hitUrl).toContain("rpi.example.test"); // the RPI_INTEGRATION_API_URL default
    });
  });
});
