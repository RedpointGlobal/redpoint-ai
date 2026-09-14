import type { RPIAuthService } from "./rpi-auth.js";
import { filterResponse } from "./response-filter.js";
import { safeErrorDetail } from "./http-error.js";

/**
 * Error from an RPI API call, carrying the HTTP status so the tool-registrar's
 * graceful-error classifier (auth-scope.ts) can distinguish 401 (session) from
 * 403 (authorization) without parsing the message. The message stays body-free
 * per the http-error no-leak guarantee.
 */
export class RpiApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Retry-After wait in ms, parsed from the response header (429s). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RpiApiError";
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or undefined. */
export function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

export interface RequestOptions {
  /** When true, skip the verbose-field stripping applied to the response. */
  verbose?: boolean;
  /**
   * Per-call override for the `X-ClientID` header. Falls back to
   * the client's `defaultClientId` when omitted.
   */
  clientId?: string;
  /**
   * Per-request RPI target base URL ("Environment Location"). Falls back to the
   * client's construction-time `baseUrl` (RPI_INTEGRATION_API_URL) when omitted —
   * that fallback is for genuinely no-URL paths (proxy/non-interactive) only. The
   * per-request URL originates from a VALIDATED `X-RPI-URL` header, surfaced on
   * `extra.authInfo.targetUrl` and threaded here by the tool handler. Callers in
   * a request context MUST pass `extra.authInfo?.targetUrl`; omitting it (silently
   * using the default when the rep chose another location) would be a
   * wrong-location/wrong-tenant bug.
   *
   * REQUIRED (value may be `undefined`) — Phase 1a fail-loud: a RequestOptions
   * literal that omits `baseUrl` is a COMPILE error, so a new tool call site
   * can't silently default to the boot instance. Pass `targetUrlOf(extra)` from a
   * handler, or `undefined` for a genuine no-per-request-URL / internal path.
   */
  baseUrl: string | undefined;
  /**
   * Optional AbortSignal for a HARD per-call timeout. A single slow RPI request
   * (e.g. a dense workflow-instances page) could otherwise stall a whole tool past
   * the transport ceiling — the caller aborts the fetch so control returns and the
   * tool can degrade to a partial result (#27897).
   */
  signal?: AbortSignal;
}

export class RPIApiClient {
  private baseUrl: string;
  private authService: RPIAuthService;
  private defaultClientId: string;

  constructor(
    baseUrl: string,
    authService: RPIAuthService,
    defaultClientId: string,
  ) {
    // Ensure baseUrl has no trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authService = authService;
    this.defaultClientId = defaultClientId;
  }

  private async buildHeaders(
    userToken: string | undefined,
    clientId: string | undefined,
  ): Promise<Record<string, string>> {
    // Auth is resolved UPSTREAM by resolveToolAuth (auth-scope.ts) and injected
    // as the per-call token. There is deliberately NO proxy fallback here — a
    // missing token is fail-closed (401), never silently escalated to the shared
    // proxy/admin account. This closes the "silent-admin" hole the old
    // `userToken ?? getProxyToken()` one-liner left open.
    if (!userToken) {
      throw new RpiApiError(401, "RPI API error: no authenticated token for call");
    }
    // Use || (not ??) so empty-string clientId from LLM tool args falls
    // back to the default instead of short-circuiting the nullish check.
    const effectiveClientId = clientId?.trim() || this.defaultClientId;
    if (!effectiveClientId) {
      throw new Error(
        "RPI client ID not set. Pass `clientId` in the call or configure RPI_DEFAULT_CLIENT_ID.",
      );
    }
    return {
      Authorization: `Bearer ${userToken}`,
      "X-ClientID": effectiveClientId,
    };
  }

  private buildUrl(
    path: string,
    params?: Record<string, string>,
    baseUrl?: string,
  ): URL {
    // Per-request "Environment Location" override, else the construction-time
    // default. The override is already host-allowlist-validated upstream.
    const url = new URL(`${baseUrl ?? this.baseUrl}/api/v2${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url;
  }

  async get<T = unknown>(
    userToken: string | undefined,
    path: string,
    params?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, params, options?.baseUrl);
    const headers = await this.buildHeaders(userToken, options?.clientId);
    const response = await fetch(url, { headers, signal: options?.signal });
    if (!response.ok) {
      throw new RpiApiError(
        response.status,
        `RPI API error: ${safeErrorDetail(response.status, response.statusText)}`,
      );
    }
    const body = (await response.json()) as T;
    return filterResponse(body, options?.verbose ?? false);
  }

  async post<T = unknown>(
    userToken: string | undefined,
    path: string,
    body: unknown,
    options?: RequestOptions,
    params?: Record<string, string>,
  ): Promise<T> {
    const headers = {
      ...(await this.buildHeaders(userToken, options?.clientId)),
      "Content-Type": "application/json",
    };
    // Some RPI POST endpoints (e.g. /workflows/audiences/results) take params
    // on the query string rather than in the body. Callers may pass both.
    const response = await fetch(this.buildUrl(path, params, options?.baseUrl), {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      throw new RpiApiError(
        response.status,
        `RPI API error: ${safeErrorDetail(response.status, response.statusText)}`,
        response.status === 429
          ? parseRetryAfterMs(response.headers.get("retry-after"))
          : undefined,
      );
    }
    const responseBody = (await response.json()) as T;
    return filterResponse(responseBody, options?.verbose ?? false);
  }

  async patch<T = unknown>(
    userToken: string | undefined,
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const headers = {
      ...(await this.buildHeaders(userToken, options?.clientId)),
      "Content-Type": "application/json",
    };
    const response = await fetch(this.buildUrl(path, undefined, options?.baseUrl), {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new RpiApiError(
        response.status,
        `RPI API error: ${safeErrorDetail(response.status, response.statusText)}`,
      );
    }
    const responseBody = (await response.json()) as T;
    return filterResponse(responseBody, options?.verbose ?? false);
  }

  async put<T = unknown>(
    userToken: string | undefined,
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const headers = {
      ...(await this.buildHeaders(userToken, options?.clientId)),
      "Content-Type": "application/json",
    };
    const response = await fetch(this.buildUrl(path, undefined, options?.baseUrl), {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new RpiApiError(
        response.status,
        `RPI API error: ${safeErrorDetail(response.status, response.statusText)}`,
      );
    }
    const responseBody = (await response.json()) as T;
    return filterResponse(responseBody, options?.verbose ?? false);
  }

  async delete(
    userToken: string | undefined,
    path: string,
    options?: RequestOptions,
  ): Promise<void> {
    const headers = await this.buildHeaders(userToken, options?.clientId);
    const response = await fetch(this.buildUrl(path, undefined, options?.baseUrl), {
      method: "DELETE",
      headers,
    });
    if (!response.ok) {
      throw new RpiApiError(
        response.status,
        `RPI API error: ${safeErrorDetail(response.status, response.statusText)}`,
      );
    }
  }
}
