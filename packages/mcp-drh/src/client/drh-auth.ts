/**
 * DRH Authentication Service.
 *
 * DRH auth is Keycloak `signon`/`signoff` (NOT OAuth2 client-credentials like
 * RPI): POST /api-op/v1/auth/signon with `{username, password}` returns an
 * OPAQUE token `{ token }` (no `expires_in`). We cache the service-account
 * (proxy) token for a fixed TTL and re-signon on expiry; the DRHApiClient
 * additionally invalidates + re-signons on any 401. The token is sent as
 * `Authorization: Bearer <token>` (per the DRH backend's auth contract).
 *
 * Structure mirrors packages/mcp-rpi/src/client/rpi-auth.ts (intentional copy;
 * mcp-rpi is not refactored into a shared lib).
 */

import { safeErrorDetail } from "./http-error.js";

/** POST /api-op/v1/auth/signon response — opaque token, no expiry. */
export interface DRHTokenResponse {
  token: string;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class DRHAuthService {
  private baseUrl: string;
  private proxyUser?: string;
  private proxyPass?: string;
  private tokenTtlMs: number;
  private proxyToken: CachedToken | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;

  constructor(
    baseUrl: string,
    proxyUser?: string,
    proxyPass?: string,
    tokenTtlSeconds = 300,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.proxyUser = proxyUser;
    this.proxyPass = proxyPass;
    this.tokenTtlMs = tokenTtlSeconds * 1000;
  }

  get proxyEnabled(): boolean {
    return !!this.proxyUser && !!this.proxyPass;
  }

  /**
   * Sign on with explicit credentials → opaque token. Not cached (callers that
   * need a session manage it themselves; the proxy path uses getProxyToken()).
   */
  async signon(username: string, password: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api-op/v1/auth/signon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
      throw new Error(
        `DRH signon failed: ${safeErrorDetail(response.status, response.statusText)}`,
      );
    }
    const data = (await response.json()) as DRHTokenResponse;
    if (!data?.token) {
      throw new Error("DRH signon returned no token.");
    }
    return data.token;
  }

  /** Sign off (invalidate) a token server-side. Best-effort; never throws. */
  async signoff(token: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api-op/v1/auth/signoff`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* best-effort logout */
    }
  }

  /**
   * Get a valid service-account (proxy) token, re-signing on when the fixed-TTL
   * cache is stale. Concurrent refreshes are deduplicated. Throws if the proxy
   * user is not configured.
   */
  async getProxyToken(): Promise<string> {
    if (!this.proxyEnabled) {
      throw new Error(
        "DRH proxy user is not configured. Set DRH_PROXY_USER/DRH_PROXY_PASS or pass a per-user token.",
      );
    }
    if (this.proxyToken && Date.now() < this.proxyToken.expiresAt) {
      return this.proxyToken.token;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchProxyToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    const cached = await this.refreshPromise;
    return cached.token;
  }

  /** Drop the cached proxy token so the next getProxyToken() re-signons (401 recovery). */
  invalidateProxyToken(): void {
    this.proxyToken = null;
  }

  private async fetchProxyToken(): Promise<CachedToken> {
    const token = await this.signon(this.proxyUser!, this.proxyPass!);
    const cached: CachedToken = {
      token,
      expiresAt: Date.now() + this.tokenTtlMs,
    };
    this.proxyToken = cached;
    console.error(
      `DRH proxy user "${this.proxyUser}" signed on (token cached ${this.tokenTtlMs / 1000}s)`,
    );
    return cached;
  }
}
