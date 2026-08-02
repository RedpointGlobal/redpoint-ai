/**
 * DRH OP-ServicesAPI HTTP client.
 *
 * Thin fetch wrapper that attaches DRH's two required auth headers to every
 * call — `Authorization: Bearer <token>` (per the DRH backend's auth contract) and
 * `X-ClientId: <clientId>` — and
 * recovers from a stale proxy token: on a 401 for a proxy-token call it
 * invalidates the cached token, re-signons, and retries ONCE.
 *
 * ⚑ SECURITY `userToken ?? proxyToken` means an unauth'd
 * caller could mutate DRH via the service account. That is gated by the
 * server's incoming-auth middleware (AUTH_REQUIRED ON by default) —
 * this client assumes the caller was already authenticated.
 *
 * Structure mirrors packages/mcp-rpi/src/client/rpi-api.ts (intentional copy).
 */
import type { DRHAuthService } from "./drh-auth.js";

export interface DRHRequestOptions {
  /** X-ClientId override; falls back to the server default. */
  clientId?: string;
  /** Query params (undefined/null values are dropped). */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON request body (serialized; sets Content-Type: application/json). */
  body?: unknown;
  /** Per-user token — used instead of the proxy token when present. */
  userToken?: string;
  /** Return the raw response text instead of parsed JSON (e.g. CSV endpoints). */
  raw?: boolean;
  /** Extra headers. */
  headers?: Record<string, string>;
}

export class DRHApiClient {
  private baseUrl: string;
  private auth: DRHAuthService;
  private defaultClientId: string;
  /** Fixed deployment default for the `databaseId` on database-scoped tools
   *  (from DRH_DEFAULT_DATABASE_ID). The twin of `defaultClientId`; tools read
   *  it to resolve `databaseId ?? defaultDatabaseId`. Undefined if unset. */
  readonly defaultDatabaseId?: number;

  constructor(
    baseUrl: string,
    auth: DRHAuthService,
    defaultClientId: string,
    defaultDatabaseId?: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.auth = auth;
    this.defaultClientId = defaultClientId;
    this.defaultDatabaseId = defaultDatabaseId;
  }

  /**
   * Resolve the default database id for database-scoped tools when the caller
   * omits `databaseId`: the deployment's configured `DRH_DEFAULT_DATABASE_ID`.
   * A DR Hub tenant can hold more than one database and there is no UI to pick
   * one at runtime, so the database is deployment config — never auto-selected.
   * (Auto-discovery via `GET /databases` and a present-and-ask flow are recorded
   * as future options; the async signature is kept so either could slot in
   * without touching call sites.)
   */
  async getDefaultDatabaseId(): Promise<number> {
    if (this.defaultDatabaseId != null) return this.defaultDatabaseId;
    throw new Error(
      "No databaseId provided and DRH_DEFAULT_DATABASE_ID is not set — set it in the environment (the deployment's DR Hub database).",
    );
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: DRHRequestOptions = {},
  ): Promise<T> {
    const usingUserToken = !!opts.userToken;
    const token = opts.userToken ?? (await this.auth.getProxyToken());

    const res = await this.send(method, path, token, opts);

    // Stale-proxy-token recovery: re-signon + retry ONCE. Only for the proxy
    // token — a 401 on a caller-supplied token is the caller's problem, surface it.
    if (res.status === 401 && !usingUserToken) {
      this.auth.invalidateProxyToken();
      const fresh = await this.auth.getProxyToken();
      const retry = await this.send(method, path, fresh, opts);
      return this.parse<T>(retry, method, path, opts.raw);
    }

    return this.parse<T>(res, method, path, opts.raw);
  }

  private async send(
    method: string,
    path: string,
    token: string,
    opts: DRHRequestOptions,
  ): Promise<Response> {
    const url = this.baseUrl + path + this.queryString(opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-ClientId": opts.clientId ?? this.defaultClientId,
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    return fetch(url, { method, headers, body });
  }

  private async parse<T>(
    res: Response,
    method: string,
    path: string,
    raw?: boolean,
  ): Promise<T> {
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(
        `DRH ${method} ${path} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      );
    }
    if (raw) return (await res.text()) as unknown as T;
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Non-JSON success body (some endpoints return plain text) — hand it back.
      return text as unknown as T;
    }
  }

  private queryString(
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }
}
