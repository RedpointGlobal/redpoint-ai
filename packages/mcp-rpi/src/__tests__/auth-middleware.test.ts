import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createRpiAuthMiddleware } from "../middleware/auth.js";
import type { RPIAuthService } from "../client/rpi-auth.js";
import type { OidcVerifier, OidcVerifyResult } from "../client/oidc-discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAuthService(validateResult = true): RPIAuthService {
  return {
    validateToken: mock(() => Promise.resolve(validateResult)),
    getProxyToken: () => Promise.resolve("proxy-token"),
    getLoginSettings: () => Promise.resolve([]),
    loginUser: () =>
      Promise.resolve({
        access_token: "user-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    refreshUserToken: () =>
      Promise.resolve({
        access_token: "user-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
  } as unknown as RPIAuthService;
}

function createMockOidcVerifier(
  result: OidcVerifyResult,
): OidcVerifier {
  return {
    config: {
      jwksUri: "https://example.com/certs",
      issuer: "https://example.com",
    },
    verifyToken: mock(() => Promise.resolve(result)),
  };
}

/** Build a DECODABLE (unsigned-payload) 3-part JWT carrying a given `iss` (+ sub). The
 *  middleware's issuer gate decodes iss UNVERIFIED to route; the signature is never checked
 *  here (the mock verifier decides validity), so a placeholder "sig" is fine. */
function jwtWithIssuer(iss: string | null, sub = "test"): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const payload: Record<string, unknown> = { sub };
  if (iss !== null) payload.iss = iss;
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const KEYCLOAK_ISSUER = "https://example.com"; // matches createMockOidcVerifier().config.issuer
const RPI_ISSUER = "https://rpi-identityserver.example.com/"; // native RPI token issuer (note trailing slash)

function createApp(
  authService: RPIAuthService,
  authRequired: boolean,
  oidcVerifier?: OidcVerifier | null,
) {
  const app = new Hono();
  const mw = createRpiAuthMiddleware(authService, authRequired, oidcVerifier);
  app.use("/mcp", mw);
  app.all("/mcp", (c) =>
    c.json({ ok: true, authInfo: c.get("authInfo") }),
  );
  return app;
}

async function request(
  app: Hono,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await app.request("/mcp", { method: "POST", headers });
  const body = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth middleware", () => {
  describe("authRequired=false (dev mode)", () => {
    it("skips validation and allows request", async () => {
      const authService = createMockAuthService();
      const app = createApp(authService, false);

      const { status, body } = await request(app);

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(authService.validateToken).not.toHaveBeenCalled();
    });
  });

  describe("authRequired=true, no OIDC verifier", () => {
    it("returns 401 without Authorization header", async () => {
      const authService = createMockAuthService();
      const app = createApp(authService, true);

      const { status } = await request(app);

      expect(status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const authService = createMockAuthService(false);
      const app = createApp(authService, true);

      const { status } = await request(app, "bad-token");

      expect(status).toBe(401);
    });

    it("allows request with valid token via validateTokenStatus", async () => {
      const authService = createMockAuthService(true);
      const app = createApp(authService, true);

      const { status, body } = await request(app, "good-token");

      expect(status).toBe(200);
      expect(body.authInfo.token).toBe("good-token");
      expect(body.authInfo.clientId).toBe("rpi-user");
    });
  });

  describe("authRequired=true, with OIDC verifier", () => {
    it("uses JWKS for JWT-shaped tokens when OIDC valid", async () => {
      const authService = createMockAuthService(true);
      const oidcVerifier = createMockOidcVerifier({
        valid: true,
        sub: "oidc-user-123",
        claims: { sub: "oidc-user-123" },
      });
      const app = createApp(authService, true, oidcVerifier);

      // Realistic SSO token: a real Keycloak JWT carries iss = the realm issuer (matching
      // the verifier's config.issuer), which routes it to the JWKS crypto verify.
      const { status, body } = await request(app, jwtWithIssuer(KEYCLOAK_ISSUER));

      expect(status).toBe(200);
      expect(body.authInfo.clientId).toBe("oidc-user-123");
      expect(oidcVerifier.verifyToken).toHaveBeenCalledTimes(1);
      expect(authService.validateToken).not.toHaveBeenCalled();
    });

    it("falls back to validateTokenStatus when JWKS fails", async () => {
      const authService = createMockAuthService(true);
      const oidcVerifier = createMockOidcVerifier({ valid: false });
      const app = createApp(authService, true, oidcVerifier);

      // Realistic SSO token (iss = Keycloak) so it routes to crypto verify; the verify
      // FAILS ({valid:false}) → falls through to validateToken.
      const { status, body } = await request(app, jwtWithIssuer(KEYCLOAK_ISSUER));

      expect(status).toBe(200);
      expect(body.authInfo.clientId).toBe("rpi-user"); // fell through to validateToken
      expect(oidcVerifier.verifyToken).toHaveBeenCalledTimes(1);
      expect(authService.validateToken).toHaveBeenCalledTimes(1);
    });

    it("returns 401 when both JWKS and validateTokenStatus fail", async () => {
      const authService = createMockAuthService(false);
      const oidcVerifier = createMockOidcVerifier({ valid: false });
      const app = createApp(authService, true, oidcVerifier);

      const { status } = await request(app, "eyJ.eyJ.sig");

      expect(status).toBe(401);
    });

    it("skips JWKS for non-JWT tokens (no dots)", async () => {
      const authService = createMockAuthService(true);
      const oidcVerifier = createMockOidcVerifier({
        valid: true,
        sub: "should-not-be-called",
        claims: {},
      });
      const app = createApp(authService, true, oidcVerifier);

      const { status, body } = await request(app, "native-rpi-token-no-dots");

      expect(status).toBe(200);
      expect(body.authInfo.clientId).toBe("rpi-user"); // used validateToken, not JWKS
      expect(oidcVerifier.verifyToken).not.toHaveBeenCalled();
      expect(authService.validateToken).toHaveBeenCalledTimes(1);
    });
  });

  // #28066 fix — issuer gate: only a Keycloak-issued JWT gets the (slow, remote) JWKS
  // crypto verify; a native RPI JWT (its own IdentityServer issuer) SKIPS it and is
  // authorized by validateToken. Kills the doomed 5000ms-ceiling JWKS refetch on the
  // native path. These assert BOTH the fast path AND the security invariant (an SSO token
  // must NEVER be routed to skip-verify).
  describe("issuer gate — native skips JWKS verify, SSO still crypto-verifies", () => {
    it("NATIVE (RPI-issuer) JWT → verify NOT invoked, routed to validateToken, authorizes", async () => {
      const authService = createMockAuthService(true);
      const oidcVerifier = createMockOidcVerifier({ valid: true, sub: "SHOULD-NOT-BE-USED", claims: {} });
      const app = createApp(authService, true, oidcVerifier);
      const { status, body } = await request(app, jwtWithIssuer(RPI_ISSUER));
      expect(status).toBe(200);
      expect(oidcVerifier.verifyToken).not.toHaveBeenCalled(); // no doomed JWKS fetch
      expect(authService.validateToken).toHaveBeenCalledTimes(1);
      expect(body.authInfo.clientId).toBe("rpi-user");
    });

    it("SSO (Keycloak-issuer) JWT → verify IS invoked + succeeds (no-regression + security)", async () => {
      const authService = createMockAuthService(true);
      const oidcVerifier = createMockOidcVerifier({ valid: true, sub: "oidc-user-123", claims: { sub: "oidc-user-123" } });
      const app = createApp(authService, true, oidcVerifier);
      const { status, body } = await request(app, jwtWithIssuer(KEYCLOAK_ISSUER));
      expect(status).toBe(200);
      expect(oidcVerifier.verifyToken).toHaveBeenCalledTimes(1); // crypto verify ran
      expect(authService.validateToken).not.toHaveBeenCalled();
      expect(body.authInfo.clientId).toBe("oidc-user-123");
    });

    it("SECURITY: SSO iss with TRAILING-SLASH variant still crypto-verifies (not misrouted to skip)", async () => {
      const authService = createMockAuthService(true);
      const oidcVerifier = createMockOidcVerifier({ valid: true, sub: "oidc-user-123", claims: {} });
      const app = createApp(authService, true, oidcVerifier);
      // configured issuer = "https://example.com" (no slash); token iss = with slash + mixed case
      const { status } = await request(app, jwtWithIssuer("https://EXAMPLE.com/"));
      expect(status).toBe(200);
      expect(oidcVerifier.verifyToken).toHaveBeenCalledTimes(1); // normalized match → verify, NOT skip
    });

    it("native iss with/without trailing slash both SKIP verify (normalized, still native)", async () => {
      for (const iss of [RPI_ISSUER, RPI_ISSUER.replace(/\/$/, "")]) {
        const authService = createMockAuthService(true);
        const oidcVerifier = createMockOidcVerifier({ valid: true, sub: "x", claims: {} });
        const app = createApp(authService, true, oidcVerifier);
        const { status } = await request(app, jwtWithIssuer(iss));
        expect(status).toBe(200);
        expect(oidcVerifier.verifyToken).not.toHaveBeenCalled();
      }
    });

    it("UNKNOWN issuer → skip verify → validateToken; invalid there → 401 (never silently allowed)", async () => {
      const authService = createMockAuthService(false);
      const oidcVerifier = createMockOidcVerifier({ valid: true, sub: "x", claims: {} });
      const app = createApp(authService, true, oidcVerifier);
      const { status } = await request(app, jwtWithIssuer("https://some-other-idp.example.org/"));
      expect(status).toBe(401);
      expect(oidcVerifier.verifyToken).not.toHaveBeenCalled();
    });

    it("NO iss claim → skip verify → validateToken (rejects when invalid; authorizes when valid)", async () => {
      const reject = createApp(createMockAuthService(false), true, createMockOidcVerifier({ valid: true, sub: "x", claims: {} }));
      expect((await request(reject, jwtWithIssuer(null))).status).toBe(401);
      const okSvc = createMockAuthService(true);
      const okVerifier = createMockOidcVerifier({ valid: true, sub: "x", claims: {} });
      const okApp = createApp(okSvc, true, okVerifier);
      const { status, body } = await request(okApp, jwtWithIssuer(null));
      expect(status).toBe(200);
      expect(body.authInfo.clientId).toBe("rpi-user");
      expect(okVerifier.verifyToken).not.toHaveBeenCalled();
    });

    it("MALFORMED 3-part token (undecodable payload) → skip verify → validateToken (rejects → 401)", async () => {
      const authService = createMockAuthService(false);
      const oidcVerifier = createMockOidcVerifier({ valid: true, sub: "x", claims: {} });
      const app = createApp(authService, true, oidcVerifier);
      const { status } = await request(app, "not.a.jwt");
      expect(status).toBe(401);
      expect(oidcVerifier.verifyToken).not.toHaveBeenCalled(); // decode threw → routed to validateToken
    });
  });

  describe("X-RPI-URL — per-request Environment Location (SSRF-guarded)", () => {
    // The allowlist is empty by default; configure it so an allowed host exists.
    const origAllowlist = process.env.RPI_URL_ALLOWLIST;
    beforeEach(() => {
      process.env.RPI_URL_ALLOWLIST = "example.com";
    });
    afterEach(() => {
      if (origAllowlist === undefined) delete process.env.RPI_URL_ALLOWLIST;
      else process.env.RPI_URL_ALLOWLIST = origAllowlist;
    });
    const ALLOWED = "https://dev-x.example.com";

    it("valid allowlisted X-RPI-URL → authInfo.targetUrl set + token validated against it", async () => {
      const authService = createMockAuthService(true);
      const app = createApp(authService, true);
      const { status, body } = await request(app, "tok", { "X-RPI-URL": ALLOWED });
      expect(status).toBe(200);
      expect(body.authInfo.targetUrl).toBe(ALLOWED);
      // validateToken received the per-request base (rep's instance).
      expect(authService.validateToken).toHaveBeenCalledWith("tok", ALLOWED);
    });

    it("non-allowlisted X-RPI-URL → 400, token never validated (never connects)", async () => {
      const authService = createMockAuthService(true);
      const app = createApp(authService, true);
      const { status } = await request(app, "tok", {
        "X-RPI-URL": "https://evil.attacker.com",
      });
      expect(status).toBe(400);
      expect(authService.validateToken).not.toHaveBeenCalled();
    });

    it("non-https X-RPI-URL → 400", async () => {
      const authService = createMockAuthService(true);
      const app = createApp(authService, true);
      const { status } = await request(app, "tok", {
        "X-RPI-URL": "http://dev-x.example.com",
      });
      expect(status).toBe(400);
    });

    it("absent X-RPI-URL → authInfo.targetUrl undefined; validated against the default", async () => {
      const authService = createMockAuthService(true);
      const app = createApp(authService, true);
      const { status, body } = await request(app, "tok");
      expect(status).toBe(200);
      expect(body.authInfo.targetUrl).toBeUndefined();
      expect(authService.validateToken).toHaveBeenCalledWith("tok", undefined);
    });
  });
});
