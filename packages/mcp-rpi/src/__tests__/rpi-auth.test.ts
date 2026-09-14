import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { RPIAuthService } from "../client/rpi-auth.js";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
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
// Tests
// ---------------------------------------------------------------------------

describe("RPIAuthService", () => {
  afterEach(() => {
    restoreFetch();
  });

  describe("getProxyToken", () => {
    it("fetches a token from /connect/token", async () => {
      mockFetch((url) => {
        if (url.includes("/connect/token")) {
          return jsonResponse({
            access_token: "proxy-token-123",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      const token = await auth.getProxyToken();

      expect(token).toBe("proxy-token-123");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("caches the token on subsequent calls", async () => {
      mockFetch(() =>
        jsonResponse({
          access_token: "cached-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      await auth.getProxyToken();
      await auth.getProxyToken();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("sends correct form parameters", async () => {
      let capturedBody: URLSearchParams | null = null;
      mockFetch(async (_url, init) => {
        capturedBody = init?.body as URLSearchParams;
        return jsonResponse({
          access_token: "token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      });

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "myclient",
        "mysecret",
        "myuser",
        "mypass",
      );
      await auth.getProxyToken();

      expect(capturedBody!.get("grant_type")).toBe("password");
      expect(capturedBody!.get("username")).toBe("myuser");
      expect(capturedBody!.get("password")).toBe("mypass");
      expect(capturedBody!.get("client_id")).toBe("myclient");
      expect(capturedBody!.get("client_secret")).toBe("mysecret");
    });

    it("throws on auth failure", async () => {
      mockFetch(() => new Response("Unauthorized", { status: 401 }));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "bad-pass",
      );

      expect(auth.getProxyToken()).rejects.toThrow("RPI token request failed");
    });

    it("throws when proxy is not configured", async () => {
      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
      );

      expect(auth.proxyEnabled).toBe(false);
      expect(auth.getProxyToken()).rejects.toThrow("Proxy user is not configured");
    });

    it("strips /api/v2 suffix from baseUrl", async () => {
      let capturedUrl = "";
      mockFetch((url) => {
        capturedUrl = url;
        return jsonResponse({
          access_token: "token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      });

      const auth = new RPIAuthService(
        "https://rpi.example.com/api/v2",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      await auth.getProxyToken();

      expect(capturedUrl).toBe("https://rpi.example.com/connect/token");
    });
  });

  describe("validateToken", () => {
    it("returns true for valid token (200)", async () => {
      mockFetch(() => jsonResponse({ status: "valid" }));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      const result = await auth.validateToken("good-token");

      expect(result).toBe(true);
    });

    it("returns false for invalid token (401)", async () => {
      mockFetch(() => new Response("Unauthorized", { status: 401 }));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      const result = await auth.validateToken("bad-token");

      expect(result).toBe(false);
    });

    it("caches validation results", async () => {
      mockFetch(() => jsonResponse({ status: "valid" }));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      await auth.validateToken("token-1");
      await auth.validateToken("token-1");

      // First call is to validate-token-status, second should be cached
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    // #28066 fix — the validate-token-status fetch is now bounded (AbortSignal.timeout)
    // so it can't hang unbounded; a timeout/network error is a CLEAN failure, not a hang.
    it("bounded: passes an AbortSignal to the fetch (so it can't hang unbounded)", async () => {
      let sawSignal = false;
      mockFetch((_url, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return jsonResponse({ status: "valid" });
      });
      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      const result = await auth.validateToken("tok");
      expect(result).toBe(true);
      expect(sawSignal).toBe(true);
    });

    it("bounded: fetch rejection (timeout/abort) → clean false, NOT a throw, NOT cached", async () => {
      let calls = 0;
      mockFetch(() => {
        calls++;
        return Promise.reject(
          Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
        );
      });
      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      // Does not throw — resolves to a clean false.
      await expect(auth.validateToken("tok")).resolves.toBe(false);
      // NOT cached: a transient stall must not lock the token out for the TTL — retries.
      await auth.validateToken("tok");
      expect(calls).toBe(2);
    });
  });

  describe("loginUser", () => {
    it("authenticates a native RPI user and returns their token", async () => {
      mockFetch(() =>
        jsonResponse({
          access_token: "native-user-token-abc",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "proxy-user",
        "proxy-pass",
      );
      const result = await auth.loginUser("native.user@company.com", "user-pass");

      expect(result.access_token).toBe("native-user-token-abc");
      expect(result.expires_in).toBe(3600);
      expect(result.token_type).toBe("Bearer");
    });

    it("sends the user credentials, not the proxy credentials", async () => {
      let capturedBody: URLSearchParams | null = null;
      mockFetch(async (_url, init) => {
        capturedBody = init?.body as URLSearchParams;
        return jsonResponse({
          access_token: "user-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      });

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "proxy-user",
        "proxy-pass",
      );
      await auth.loginUser("native.user@company.com", "native-pass");

      expect(capturedBody!.get("username")).toBe("native.user@company.com");
      expect(capturedBody!.get("password")).toBe("native-pass");
      expect(capturedBody!.get("grant_type")).toBe("password");
      expect(capturedBody!.get("client_id")).toBe("client-id");
      expect(capturedBody!.get("client_secret")).toBe("client-secret");
    });

    it("throws on invalid credentials", async () => {
      mockFetch(() => new Response("Invalid username or password", { status: 401 }));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "proxy-user",
        "proxy-pass",
      );

      expect(auth.loginUser("bad-user", "bad-pass")).rejects.toThrow(
        "RPI user login failed",
      );
    });

    it("does not affect the proxy token cache", async () => {
      let callCount = 0;
      mockFetch(() => {
        callCount++;
        return jsonResponse({
          access_token: callCount === 1 ? "proxy-token" : "user-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      });

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "proxy-user",
        "proxy-pass",
      );

      // Get proxy token first (cached)
      const proxyToken = await auth.getProxyToken();
      expect(proxyToken).toBe("proxy-token");

      // Login as a different user
      const userResult = await auth.loginUser("native.user@company.com", "user-pass");
      expect(userResult.access_token).toBe("user-token");

      // Proxy token should still be the cached one
      const proxyAgain = await auth.getProxyToken();
      expect(proxyAgain).toBe("proxy-token");
    });

    it("returns refresh_token when the tenant issues one", async () => {
      mockFetch(() =>
        jsonResponse({
          access_token: "user-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "user-refresh",
        }),
      );

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
      );
      const result = await auth.loginUser("native.user@company.com", "user-pass");

      expect(result.refresh_token).toBe("user-refresh");
    });
  });

  describe("refreshUserToken", () => {
    it("exchanges a refresh_token for a fresh access_token", async () => {
      let capturedBody: URLSearchParams | null = null;
      mockFetch(async (_url, init) => {
        capturedBody = init?.body as URLSearchParams;
        return jsonResponse({
          access_token: "refreshed-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rotated-refresh",
        });
      });

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
      );
      const result = await auth.refreshUserToken("original-refresh");

      expect(result.access_token).toBe("refreshed-access");
      expect(result.refresh_token).toBe("rotated-refresh");
      expect(capturedBody!.get("grant_type")).toBe("refresh_token");
      expect(capturedBody!.get("refresh_token")).toBe("original-refresh");
      expect(capturedBody!.get("client_id")).toBe("client-id");
      expect(capturedBody!.get("client_secret")).toBe("client-secret");
    });

    it("throws when the refresh_token is rejected", async () => {
      mockFetch(() => new Response("invalid_grant", { status: 400 }));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
      );

      expect(auth.refreshUserToken("expired-refresh")).rejects.toThrow(
        "RPI token refresh failed",
      );
    });
  });

  describe("getLoginSettings", () => {
    it("unwraps the { settings: [...] } envelope returned by RPI", async () => {
      const settings = [
        { authenticationType: "NATIVE", isExternal: false },
        { authenticationType: "OPENID", isExternal: true },
      ];
      mockFetch(() => jsonResponse({ settings }));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      const result = await auth.getLoginSettings();

      expect(result).toHaveLength(2);
      expect(result[0].authenticationType).toBe("NATIVE");
      expect(result[1].isExternal).toBe(true);
    });

    it("accepts a bare array response for backward compatibility", async () => {
      const settings = [{ authenticationType: "NATIVE", isExternal: false }];
      mockFetch(() => jsonResponse(settings));

      const auth = new RPIAuthService(
        "https://rpi.example.com",
        "client-id",
        "client-secret",
        "user",
        "pass",
      );
      const result = await auth.getLoginSettings();

      expect(result).toHaveLength(1);
    });
  });
});
