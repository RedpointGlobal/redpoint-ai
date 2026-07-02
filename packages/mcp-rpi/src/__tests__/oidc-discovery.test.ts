import { describe, it, expect, afterEach, mock } from "bun:test";
import { discoverOidcConfig, createOidcVerifier } from "../client/oidc-discovery.js";
import type { RPIAuthService } from "../client/rpi-auth.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = mock(handler as any) as any;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Mock auth service
// ---------------------------------------------------------------------------

function createMockAuthService(
  loginSettings: any[] = [],
  shouldThrow = false,
): RPIAuthService {
  return {
    getLoginSettings: shouldThrow
      ? () => Promise.reject(new Error("RPI unreachable"))
      : () => Promise.resolve(loginSettings),
    getProxyToken: () => Promise.resolve("proxy-token"),
    validateToken: () => Promise.resolve(true),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverOidcConfig", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("discovers OIDC from login settings with OPENID entry", async () => {
    const authService = createMockAuthService([
      { authenticationType: "Native", isExternal: false },
      {
        authenticationType: "OpenID",
        isExternal: true,
        authorizationHost: "https://keycloak.example.com/realms/rpi",
        audience: "rpi-api",
      },
    ]);

    mockFetch((url) => {
      if (url.includes(".well-known/openid-configuration")) {
        return jsonResponse({
          issuer: "https://keycloak.example.com/realms/rpi",
          jwks_uri:
            "https://keycloak.example.com/realms/rpi/protocol/openid-connect/certs",
          authorization_endpoint:
            "https://keycloak.example.com/realms/rpi/protocol/openid-connect/auth",
          token_endpoint:
            "https://keycloak.example.com/realms/rpi/protocol/openid-connect/token",
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const config = await discoverOidcConfig(authService);

    expect(config).not.toBeNull();
    expect(config!.issuer).toBe("https://keycloak.example.com/realms/rpi");
    expect(config!.jwksUri).toBe(
      "https://keycloak.example.com/realms/rpi/protocol/openid-connect/certs",
    );
    expect(config!.audience).toBe("rpi-api");
  });

  it("uses openIDIssuer field when authorizationHost is absent", async () => {
    const authService = createMockAuthService([
      {
        authenticationType: "OpenID",
        isExternal: true,
        openIDIssuer: "https://idp.example.com",
      },
    ]);

    mockFetch(() =>
      jsonResponse({
        issuer: "https://idp.example.com",
        jwks_uri: "https://idp.example.com/.well-known/jwks.json",
      }),
    );

    const config = await discoverOidcConfig(authService);

    expect(config).not.toBeNull();
    expect(config!.issuer).toBe("https://idp.example.com");
  });

  it("returns null when no OPENID entry in login settings", async () => {
    const authService = createMockAuthService([
      { authenticationType: "Native", isExternal: false },
    ]);

    const config = await discoverOidcConfig(authService);

    expect(config).toBeNull();
  });

  it("returns null when RPI is unreachable (no crash)", async () => {
    const authService = createMockAuthService([], true);

    const config = await discoverOidcConfig(authService);

    expect(config).toBeNull();
  });

  it("falls back to underscore .well-known path", async () => {
    const authService = createMockAuthService([
      {
        authenticationType: "OpenID",
        isExternal: true,
        authorizationHost: "https://rpi.example.com",
      },
    ]);

    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      // Standard path fails
      if (url.includes("openid-configuration")) {
        return new Response("Not found", { status: 404 });
      }
      // Underscore path succeeds
      if (url.includes("openid_configuration")) {
        return jsonResponse({
          issuer: "https://rpi.example.com",
          jwks_uri: "https://rpi.example.com/certs",
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const config = await discoverOidcConfig(authService);

    expect(config).not.toBeNull();
    expect(config!.issuer).toBe("https://rpi.example.com");
    expect(callCount).toBe(2); // tried standard first, then underscore
  });

  it("returns null when discovery document fetch fails", async () => {
    const authService = createMockAuthService([
      {
        authenticationType: "OpenID",
        isExternal: true,
        authorizationHost: "https://rpi.example.com",
      },
    ]);

    mockFetch(() => new Response("Not found", { status: 404 }));

    const config = await discoverOidcConfig(authService);

    expect(config).toBeNull();
  });

  it("returns null when OPENID entry has no issuer URL fields", async () => {
    const authService = createMockAuthService([
      {
        authenticationType: "OpenID",
        isExternal: true,
        // No authorizationHost, openIDIssuer, authority, or issuer fields
        name: "Some Provider",
      },
    ]);

    const config = await discoverOidcConfig(authService);

    expect(config).toBeNull();
  });
});

describe("createOidcVerifier", () => {
  it("returns a verifier with the config", () => {
    const config = {
      jwksUri: "https://example.com/certs",
      issuer: "https://example.com",
      audience: "my-api",
    };

    const verifier = createOidcVerifier(config);

    expect(verifier.config).toEqual(config);
    expect(typeof verifier.verifyToken).toBe("function");
  });

  it("returns valid: false for non-JWT tokens", async () => {
    const verifier = createOidcVerifier({
      jwksUri: "https://example.com/certs",
      issuer: "https://example.com",
    });

    const result = await verifier.verifyToken("not-a-jwt-token");

    expect(result.valid).toBe(false);
  });

  it("returns valid: false for malformed JWTs", async () => {
    const verifier = createOidcVerifier({
      jwksUri: "https://example.com/certs",
      issuer: "https://example.com",
    });

    const result = await verifier.verifyToken("eyJ.eyJ.invalid");

    expect(result.valid).toBe(false);
  });
});
