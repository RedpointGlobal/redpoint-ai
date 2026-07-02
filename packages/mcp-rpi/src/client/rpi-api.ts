import type { RPIAuthService } from "./rpi-auth.js";
import { filterResponse } from "./response-filter.js";

export interface RequestOptions {
  /** When true, skip the verbose-field stripping applied to the response. */
  verbose?: boolean;
  /**
   * Per-call override for the `X-ClientID` header. Falls back to
   * the client's `defaultClientId` when omitted.
   */
  clientId?: string;
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
    const token = userToken ?? (await this.authService.getProxyToken());
    // Use || (not ??) so empty-string clientId from LLM tool args falls
    // back to the default instead of short-circuiting the nullish check.
    const effectiveClientId = clientId?.trim() || this.defaultClientId;
    if (!effectiveClientId) {
      throw new Error(
        "RPI client ID not set. Pass `clientId` in the call or configure RPI_DEFAULT_CLIENT_ID.",
      );
    }
    return {
      Authorization: `Bearer ${token}`,
      "X-ClientID": effectiveClientId,
    };
  }

  private buildUrl(path: string, params?: Record<string, string>): URL {
    const url = new URL(`${this.baseUrl}/api/v2${path}`);
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
    const url = this.buildUrl(path, params);
    const headers = await this.buildHeaders(userToken, options?.clientId);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `RPI API error: ${response.status} ${response.statusText} — ${await response.text()}`,
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
    const response = await fetch(this.buildUrl(path, params), {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `RPI API error: ${response.status} ${response.statusText} — ${await response.text()}`,
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
    const response = await fetch(this.buildUrl(path), {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `RPI API error: ${response.status} ${response.statusText} — ${await response.text()}`,
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
    const response = await fetch(this.buildUrl(path), {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `RPI API error: ${response.status} ${response.statusText} — ${await response.text()}`,
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
    const response = await fetch(this.buildUrl(path), {
      method: "DELETE",
      headers,
    });
    if (!response.ok) {
      throw new Error(
        `RPI API error: ${response.status} ${response.statusText} — ${await response.text()}`,
      );
    }
  }
}
