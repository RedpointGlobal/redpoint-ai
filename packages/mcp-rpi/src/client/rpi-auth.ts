/**
 * RPI Authentication Service.
 *
 * Handles proxy user token acquisition via password grant to /connect/token,
 * token caching with auto-refresh, and inbound token validation via
 * /api/v2/authentication/validate-token-status.
 */

import { safeErrorDetail } from "./http-error.js";

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
// Bound the validate-token-status fetch so it can't hang unbounded (normal ~575ms; the
// MCP transport's own budget is far larger). Well over a healthy call, well under any
// probe/transport fuse. On timeout the token is treated as a CLEAN validation failure.
const VALIDATION_FETCH_TIMEOUT_MS = 8_000;
/** The validation cache holds at most this many tokens; the least recently used goes first. */
export const MAX_VALIDATION_CACHE_ENTRIES = 10_000;

/** A token check's answer. "unavailable": RPI didn't answer (not cached); "refused": the admission said no. */
export type TokenCheck =
  | { result: "valid" }
  | { result: "invalid" }
  | { result: "unavailable" }
  | { result: "refused"; retryAfterSec: number };
/**
 * Asked once before a NEW remote validation (never for a cached or in-flight one).
 * An admission's `settle` is told the validation's answer when it arrives.
 */
export type RemoteAdmission = () =>
  | { ok: true; settle?(result: TokenCheck["result"]): void }
  | { ok: false; retryAfterSec: number };
const MIN_TOKEN_TTL_SECONDS = 60;
/** The bound on the boot-time proxy login check. */
export const PROXY_LOGIN_CHECK_TIMEOUT_MS = 15_000;

/** RPI's token endpoint REFUSED the proxy user's credentials (as opposed to not answering). */
export class ProxyLoginRejected extends Error {}

/** The proxy user's login, tried once at boot: accepted, refused by RPI, or RPI not answering. */
export type ProxyLoginStatus = "ok" | "rejected" | "unreachable";

export class RPIAuthService {
  private baseUrl: string;
  private proxyUser?: string;
  private proxyPass?: string;
  // Absent in login-only mode (AUTH_REQUIRED=true, proxy off): every call then
  // carries the caller's own token, and minting one here fails by name.
  private oauthClientId?: string;
  private oauthClientSecret?: string;
  private proxyToken: CachedToken | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;
  private validationCache = new Map<string, ValidationCacheEntry>();
  /** One remote validation per (base, token) at a time; concurrent callers share it. */
  private validationsInFlight = new Map<string, Promise<TokenCheck>>();

  constructor(
    baseUrl: string,
    oauthClientId: string | undefined,
    oauthClientSecret: string | undefined,
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

  /** The RPI OAuth client mints tokens (password / refresh grants); absent → a named error, never a request. */
  private requireOauthClient(what: string): { client_id: string; client_secret: string } {
    if (!this.oauthClientId || !this.oauthClientSecret) {
      throw new Error(
        `RPI_OAUTH_CLIENT_ID / RPI_OAUTH_CLIENT_SECRET are not set — ${what} is unavailable (login-only mode: every call must carry the caller's own RPI token).`,
      );
    }
    return { client_id: this.oauthClientId, client_secret: this.oauthClientSecret };
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
    const oauthClient = this.requireOauthClient("native password login");
    const response = await fetch(`${this.baseUrl}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username,
        password,
        ...oauthClient,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `RPI user login failed: ${safeErrorDetail(response.status, response.statusText)}`,
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
    const oauthClient = this.requireOauthClient("token refresh");
    const response = await fetch(`${this.baseUrl}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        ...oauthClient,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `RPI token refresh failed: ${safeErrorDetail(response.status, response.statusText)}`,
      );
    }

    return (await response.json()) as TokenResponse;
  }

  /**
   * Validate an arbitrary Bearer token against RPI.
   * Returns true if valid, false if unauthorized.
   * Results are cached for 30 seconds keyed by token hash.
   */
  async validateToken(token: string, targetBase?: string): Promise<boolean> {
    return (await this.checkToken(token, targetBase)).result === "valid";
  }

  /**
   * validateToken with the whole answer. A cached answer is returned as is; a token
   * already being validated joins that validation (single-flight: N concurrent
   * requests with one token → one RPI call); only a NEW remote validation asks
   * `admit` first, and a refusal is returned without calling RPI.
   */
  async checkToken(token: string, targetBase?: string, admit?: RemoteAdmission): Promise<TokenCheck> {
    // Validate against the per-request Environment Location when given, else the
    // construction-time default. Normalise like the constructor (strip /api/v2 +
    // trailing slash). Cache is keyed by (base, token) so the same token isn't
    // conflated across instances.
    const base = (targetBase ?? this.baseUrl)
      .replace(/\/api\/v2\/?$/, "")
      .replace(/\/$/, "");
    const cacheKey = `${base}::${await this.hashToken(token)}`;

    const cached = this.validationCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      // Re-insert → most recently used.
      this.validationCache.delete(cacheKey);
      this.validationCache.set(cacheKey, cached);
      return { result: cached.valid ? "valid" : "invalid" };
    }

    let pending = this.validationsInFlight.get(cacheKey);
    if (!pending) {
      const admission = admit?.();
      if (admission && !admission.ok) return { result: "refused", retryAfterSec: admission.retryAfterSec };
      const settle = admission?.settle;
      const started = this.validateRemotely(token, base, cacheKey).then(
        (check) => (settle?.(check.result), check),
        (error) => {
          settle?.("unavailable");
          throw error;
        },
      );
      pending = started.finally(() => this.validationsInFlight.delete(cacheKey));
      this.validationsInFlight.set(cacheKey, pending);
    }
    return pending;
  }

  private async validateRemotely(token: string, base: string, cacheKey: string): Promise<TokenCheck> {
    let valid: boolean;
    try {
      const response = await fetch(
        `${base}/api/v2/authentication/validate-token-status`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(VALIDATION_FETCH_TIMEOUT_MS),
        },
      );
      valid = response.ok;
    } catch {
      // Timed out (VALIDATION_FETCH_TIMEOUT_MS) or a network error — treat as a CLEAN
      // validation failure rather than a hang, and do NOT cache it: a transient stall must
      // not lock the token out for the full 30s TTL, so the next request retries fresh.
      return { result: "unavailable" };
    }

    this.validationCache.delete(cacheKey);
    this.validationCache.set(cacheKey, {
      valid,
      expiresAt: Date.now() + VALIDATION_CACHE_TTL_MS,
    });

    // Prune expired entries periodically; past the cap, drop the least recently used.
    if (this.validationCache.size > 100) {
      this.pruneValidationCache();
    }
    for (const key of this.validationCache.keys()) {
      if (this.validationCache.size <= MAX_VALIDATION_CACHE_ENTRIES) break;
      this.validationCache.delete(key);
    }

    return { result: valid ? "valid" : "invalid" };
  }

  /** How many tokens the validation cache holds (tests). */
  get validationCacheSize(): number {
    return this.validationCache.size;
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

  /**
   * Try the proxy user's login once (boot): "rejected" when RPI's token endpoint
   * refuses the credentials (HTTP 400/401/403), "unreachable" for anything else
   * (no answer, a timeout, a server error). A success caches the token.
   */
  async checkProxyLogin(timeoutMs: number = PROXY_LOGIN_CHECK_TIMEOUT_MS): Promise<ProxyLoginStatus> {
    try {
      await this.fetchToken(AbortSignal.timeout(timeoutMs));
      return "ok";
    } catch (error) {
      return error instanceof ProxyLoginRejected ? "rejected" : "unreachable";
    }
  }

  private async fetchToken(signal?: AbortSignal): Promise<CachedToken> {
    const oauthClient = this.requireOauthClient("the proxy user's token");
    const response = await fetch(`${this.baseUrl}/connect/token`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username: this.proxyUser!,
        password: this.proxyPass!,
        ...oauthClient,
      }),
    });

    if (!response.ok) {
      const message = `RPI token request failed: ${safeErrorDetail(response.status, response.statusText)}`;
      throw [400, 401, 403].includes(response.status) ? new ProxyLoginRejected(message) : new Error(message);
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
