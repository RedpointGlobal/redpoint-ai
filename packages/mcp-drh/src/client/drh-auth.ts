/**
 * DRH Authentication Service.
 *
 * DRH auth is Keycloak `signon`/`signoff` (not OAuth2 client-credentials), on
 * the v2 auth API: POST /api/v2/auth/signon with `{username, password}`
 * returns `{ accessToken, refreshToken, expiresAfter, idleTimeout, … }` (the legacy
 * /api-op/v1/auth/* calls are deprecated for us). We cache the service-account
 * (proxy) accessToken for 90% of its `expiresAfter` (seconds), so it is renewed
 * before it expires; a reply without a positive `expiresAfter` falls back to the
 * configured TTL (DRH_TOKEN_TTL_SECONDS, default 300). The DRHApiClient additionally
 * invalidates + re-signons on any 401 (which also covers an idle timeout). The
 * refreshToken is not used. The token is sent as `Authorization: Bearer <token>`.
 * Only the auth calls moved: the DATA endpoints and the token check stay on
 * /api-op/v1/*, which accept the v2 accessToken.
 */

import { createHash } from "crypto";
import { safeErrorDetail } from "./http-error.js";
import { boundedFetch } from "./upstream-limits.js";

/** A caller's token is checked by DRH at most this often (the answer is cached). */
const VALIDATION_CACHE_TTL_MS = 30_000;
/** A token check that DRH doesn't answer in time is "unavailable", not a hang. */
const VALIDATION_FETCH_TIMEOUT_MS = 8_000;
/** The validation cache holds at most this many tokens; the least recently used goes first. */
export const MAX_VALIDATION_CACHE_ENTRIES = 10_000;

/** A token check's answer. "unavailable": DRH didn't answer (not cached); "refused": the admission said no. */
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

/** POST /api/v2/auth/signon response (used: accessToken and expiresAfter). */
export interface DRHTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the accessToken expires. */
  expiresAfter?: number;
  idleTimeout?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class DRHAuthService {
  private baseUrl: string;
  private proxyUser?: string;
  private proxyPass?: string;
  /** The fallback cache TTL, for a sign-on reply without a positive expiresAfter. */
  private tokenTtlMs: number;
  private proxyToken: CachedToken | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;
  private validationCache = new Map<string, { valid: boolean; expiresAt: number }>();
  /** One remote validation per (tenant, token) at a time; concurrent callers share it. */
  private validationsInFlight = new Map<string, Promise<TokenCheck>>();

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
   * Sign on with explicit credentials → the accessToken. Not cached (callers that
   * need a session manage it themselves; the proxy path uses getProxyToken()).
   */
  async signon(username: string, password: string): Promise<string> {
    return (await this.signonRaw(username, password)).accessToken;
  }

  /** The sign-on itself: POST /api/v2/auth/signon → the parsed reply (accessToken required). */
  private async signonRaw(username: string, password: string): Promise<DRHTokenResponse> {
    // Per-request timeout + response-size cap (see upstream-limits.ts): a stalled
    // Keycloak sign-on can't hang a tool call.
    const res = await boundedFetch(
      `${this.baseUrl}/api/v2/auth/signon`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      },
      "DRH signon",
    );
    if (!res.response.ok) {
      res.discard();
      throw new Error(
        `DRH signon failed: ${safeErrorDetail(res.response.status, res.response.statusText)}`,
      );
    }
    const data = JSON.parse(await res.text()) as DRHTokenResponse;
    if (!data?.accessToken) {
      throw new Error("DRH signon returned no token.");
    }
    return data;
  }

  /** Sign off (invalidate) a token server-side. Best-effort; never throws. */
  async signoff(token: string): Promise<void> {
    try {
      const res = await boundedFetch(
        `${this.baseUrl}/api/v2/auth/signoff`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        "DRH signoff",
      );
      res.discard();
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

  /**
   * Check a caller's token for `tenant` (the pinned tenant: DRH has no tenant-agnostic
   * check, so this is sound only when the server serves one tenant). The check is
   * GET /api-op/v1/databases/default with the caller's token and X-ClientId = tenant (a
   * data endpoint: it stays on v1, and accepts the v2 accessToken).
   * ONLY a 401 means the token is invalid. Any other status admits it: 200, and also
   * 403 / 404 / 400 / 5xx, which DRH answers only for a token it authenticated. A
   * cached answer is returned as is; a token already being checked joins that check
   * (single-flight: N concurrent requests with one token → one DRH call); only a NEW
   * check asks `admit` first, and a refusal is returned without calling DRH.
   */
  async checkToken(token: string, tenant: string, admit?: RemoteAdmission): Promise<TokenCheck> {
    const cacheKey = `${tenant}::${createHash("sha256").update(token).digest("hex")}`;
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
      const started = this.validateRemotely(token, tenant, cacheKey).then(
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

  private async validateRemotely(token: string, tenant: string, cacheKey: string): Promise<TokenCheck> {
    let valid: boolean;
    try {
      const res = await boundedFetch(
        `${this.baseUrl}/api-op/v1/databases/default`,
        { method: "GET", headers: { Authorization: `Bearer ${token}`, "X-ClientId": tenant } },
        "DRH token check",
        { timeoutMs: VALIDATION_FETCH_TIMEOUT_MS, maxBytes: 64 * 1024 },
      );
      valid = res.response.status !== 401;
      res.discard();
    } catch {
      // Timed out or a network error: not the caller's failure, and not cached, so
      // the next request checks again.
      return { result: "unavailable" };
    }

    this.validationCache.delete(cacheKey);
    this.validationCache.set(cacheKey, { valid, expiresAt: Date.now() + VALIDATION_CACHE_TTL_MS });
    // Past the cap: drop expired entries, then the least recently used.
    if (this.validationCache.size > MAX_VALIDATION_CACHE_ENTRIES) {
      const now = Date.now();
      for (const [key, entry] of this.validationCache) if (now >= entry.expiresAt) this.validationCache.delete(key);
      for (const key of this.validationCache.keys()) {
        if (this.validationCache.size <= MAX_VALIDATION_CACHE_ENTRIES) break;
        this.validationCache.delete(key);
      }
    }
    return { result: valid ? "valid" : "invalid" };
  }

  /** How many tokens the validation cache holds (tests). */
  get validationCacheSize(): number {
    return this.validationCache.size;
  }

  /** Drop the cached proxy token so the next getProxyToken() re-signons (401 recovery). */
  invalidateProxyToken(): void {
    this.proxyToken = null;
  }

  private async fetchProxyToken(): Promise<CachedToken> {
    const reply = await this.signonRaw(this.proxyUser!, this.proxyPass!);
    const ttlMs = effectiveTtlMs(reply.expiresAfter, this.tokenTtlMs);
    const cached: CachedToken = {
      token: reply.accessToken,
      expiresAt: Date.now() + ttlMs,
    };
    this.proxyToken = cached;
    console.error(
      `DRH proxy user "${this.proxyUser}" signed on (token cached ${Math.round(ttlMs / 1000)}s)`,
    );
    return cached;
  }
}

/**
 * How long a sign-on reply's token is cached: 90% of its `expiresAfter` (seconds), so
 * it is renewed before it expires; without a positive `expiresAfter`, the fallback.
 */
export function effectiveTtlMs(expiresAfter: number | undefined, fallbackMs: number): number {
  return typeof expiresAfter === "number" && expiresAfter > 0 ? expiresAfter * 0.9 * 1000 : fallbackMs;
}
