import { describe, it, expect, mock } from "bun:test";
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
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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

      // JWT-shaped token (3 dot-separated parts)
      const { status, body } = await request(app, "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature");

      expect(status).toBe(200);
      expect(body.authInfo.clientId).toBe("oidc-user-123");
      expect(oidcVerifier.verifyToken).toHaveBeenCalledTimes(1);
      expect(authService.validateToken).not.toHaveBeenCalled();
    });

    it("falls back to validateTokenStatus when JWKS fails", async () => {
      const authService = createMockAuthService(true);
      const oidcVerifier = createMockOidcVerifier({ valid: false });
      const app = createApp(authService, true, oidcVerifier);

      const { status, body } = await request(app, "eyJ.eyJ.sig");

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
});
