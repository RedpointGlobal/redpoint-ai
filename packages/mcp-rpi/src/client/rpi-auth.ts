/**
 * RPI Authentication Service.
 *
 * Handles proxy user token acquisition via password grant to /connect/token,
 * token caching with auto-refresh, and inbound token validation via
 * /api/v2/authentication/validate-token-status.
 */

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

interface ValidationCacheEntry {
  valid: boolean;
  expiresAt: number; // epoch ms
}

export interface LoginSetting {
  authenticationType: string;
  isExternal: boolean;
  [key: string]: unknown;
}

const VALIDATION_CACHE_TTL_MS = 30_000; // 30 seconds
const MIN_TOKEN_TTL_SECONDS = 60;

export class RPIAuthService {
  private baseUrl: string;
  private proxyUser?: string;
  private proxyPass?: string;
  private oauthClientId: string;
  private oauthClientSecret: string;
  private proxyToken: CachedToken | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;
  private validationCache = new Map<string, ValidationCacheEntry>();

  constructor(
    baseUrl: string,
    oauthClientId: string,
    oauthClientSecret: string,
    proxyUser?: string,
    proxyPass?: string,
  ) {
    // Strip /api/v2 suffix if present — token endpoint is at the root
    this.baseUrl = baseUrl.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
    this.oauthClientId = oauthClientId;
    this.oauthClientSecret = oauthClientSecret;
    this.proxyUser = proxyUser;
    this.proxyPass = proxyPass;
  }

  get proxyEnabled(): boolean {
    return !!this.proxyUser && !!this.proxyPass;
  }

  /**
   * Get a valid proxy user Bearer token, refreshing if needed.
   * Deduplicates concurrent refresh requests.
   * Throws if the proxy user is not configured.
   */
  async getProxyToken(): Promise<string> {
    if (!this.proxyEnabled) {
      throw new Error(
        "Proxy user is not configured. Set RPI_PROXY_USER/RPI_PROXY_PASS or pass a per-user token.",
      );
    }

    if (this.proxyToken && Date.now() < this.proxyToken.expiresAt) {
      return this.proxyToken.accessToken;
    }

    // Deduplicate concurrent refreshes
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    const token = await this.refreshPromise;
    return token.accessToken;
  }

  /**
   * Authenticate a native RPI user via password grant against /connect/token.
   * Returns the full token response so callers can use `expires_in` (seconds)
   * to schedule refresh and `refresh_token` (when issued) with refreshUserToken().
   * Not all RPI tenants issue a refresh_token — callers should treat it as optional
   * and fall back to a fresh loginUser() when absent.
   * The result is NOT cached — callers manage their own session.
   */
  async loginUser(username: string, password: string): Promise<TokenResponse> {
    const response = await fetch(`${this.baseUrl}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username,
        password,
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `RPI user login failed: ${response.status} ${response.statusText} — ${await response.text()}`,
      );
    }

    const data = (await response.json()) as TokenResponse;
    console.error(`User "${username}" authenticated successfully`);
    return data;
  }

  /**
   * Exchange a refresh_token for a fresh access token via /connect/token.
   * Mirrors loginUser()'s contract: result is not cached, refresh_token may be
   * absent on the response (some tenants only issue it on the initial login).
   * Throws if the refresh token is rejected — callers should fall back to
   * loginUser() with stored credentials, or prompt the user to reauthenticate.
   */
  async refreshUserToken(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(`${this.baseUrl}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `RPI token refresh failed: ${response.status} ${response.statusText} — ${await response.text()}`,
      );
    }

    return (await response.json()) as TokenResponse;
  }

  /**
   * Validate an arbitrary Bearer token against RPI.
   * Returns true if valid, false if unauthorized.
   * Results are cached for 30 seconds keyed by token hash.
   */
  async validateToken(token: string): Promise<boolean> {
    const cacheKey = await this.hashToken(token);

    const cached = this.validationCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.valid;
    }

    const response = await fetch(
      `${this.baseUrl}/api/v2/authentication/validate-token-status`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const valid = response.ok;
    this.validationCache.set(cacheKey, {
      valid,
      expiresAt: Date.now() + VALIDATION_CACHE_TTL_MS,
    });

    // Prune expired entries periodically
    if (this.validationCache.size > 100) {
      this.pruneValidationCache();
    }

    return valid;
  }

  /**
   * Fetch available login settings from the RPI instance (no auth required).
   * RPI wraps the array in a `{ settings: [...] }` envelope; we unwrap it here.
   */
  async getLoginSettings(): Promise<LoginSetting[]> {
    const response = await fetch(
      `${this.baseUrl}/api/v2/authentication/login-settings`,
    );
    if (!response.ok) {
      throw new Error(
        `Failed to fetch login settings: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as
      | LoginSetting[]
      | { settings: LoginSetting[] };
    return Array.isArray(body) ? body : body.settings ?? [];
  }

  private async fetchToken(): Promise<CachedToken> {
    const response = await fetch(`${this.baseUrl}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username: this.proxyUser!,
        password: this.proxyPass!,
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `RPI token request failed: ${response.status} ${response.statusText} — ${await response.text()}`,
      );
    }

    const data = (await response.json()) as TokenResponse;
    const ttlSeconds = Math.max(data.expires_in - 60, MIN_TOKEN_TTL_SECONDS);

    console.error(
      `Proxy user "${this.proxyUser}" authenticated successfully (token expires in ${ttlSeconds}s)`,
    );

    const cached: CachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };

    this.proxyToken = cached;
    return cached;
  }

  private async hashToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private pruneValidationCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.validationCache) {
      if (now >= entry.expiresAt) {
        this.validationCache.delete(key);
      }
    }
  }
}
