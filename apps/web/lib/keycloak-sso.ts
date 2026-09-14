/**
 * SSO (Keycloak) — password-grant login helpers for the web app.
 *
 * This is the zero-external-dependency SSO path: it is the same OAuth2 password
 * (direct-access) grant the rpi-native provider uses, pointed at the realm's
 * Keycloak token endpoint instead of RPI's /connect/token. The client is PUBLIC
 * (no client_secret). The Keycloak-issued JWT is already accepted by RPI
 * directly and by the apps/server OIDC branch, and stable-id metering keys it
 * to rpi:<stableId> automatically — so no server change is needed.
 *
 * CONFIG BY DISCOVERY (mirrors packages/mcp-rpi/src/client/oidc-discovery.ts):
 * we read RPI's unauthenticated login-settings, find the OpenID entry, and
 * derive the token endpoint from its PUBLIC `openIDIssuer`. We deliberately
 * DO NOT use the entry's `tokenEndpoint` field — RPI reports that as a
 * cluster-INTERNAL host, which is unreachable from the browser/edge. We also
 * don't fetch the .well-known document: appending
 * Keycloak's standard `/protocol/openid-connect/token` path to the
 * confirmed-public issuer depends on ONLY that public value and cannot
 * accidentally surface an internal endpoint from a discovery response.
 *
 * Env fallback (KEYCLOAK_SSO_ISSUER / KEYCLOAK_SSO_CLIENT_ID) is honoured when
 * login-settings is unreachable — but it too MUST be the public issuer.
 */

/** Wire-format token response (OAuth2 snake_case, kept verbatim). */
interface KeycloakTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** The rpi* session fields a successful grant/refresh maps into. */
export interface KeycloakSession {
  rpiAccessToken: string;
  rpiRefreshToken?: string;
  rpiExpiresAt: number;
}

export interface KeycloakSsoConfig {
  /** PUBLIC realm issuer (login-settings openIDIssuer). The redirect/OIDC flow
   * discovers authorize/token/jwks from this via .well-known. */
  issuer: string;
  /** PUBLIC Keycloak token endpoint (issuer + /protocol/openid-connect/token) —
   * used directly by the interim password/refresh grants. */
  tokenEndpoint: string;
  /** Public client id (e.g. `rpi`). */
  clientId: string;
}

const DISCOVERY_TIMEOUT_MS = 5000;

/** RPI API base (no /api/v2 suffix, no trailing slash), or null if unset. */
function rpiApiBase(): string | null {
  const raw = process.env.RPI_INTEGRATION_API_URL;
  if (!raw) return null;
  return raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
}

/** Keycloak's standard token endpoint for a given (public) realm issuer. */
function tokenEndpointFor(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/protocol/openid-connect/token`;
}

/**
 * Discover the PUBLIC Keycloak token endpoint + client id.
 *
 * Primary source: RPI login-settings' OpenID entry (`openIDIssuer` + `clientID`).
 * Fallback: KEYCLOAK_SSO_ISSUER / KEYCLOAK_SSO_CLIENT_ID env (public issuer only).
 * Returns null when neither yields a usable public issuer + client id.
 */
export async function discoverKeycloakSso(): Promise<KeycloakSsoConfig | null> {
  let issuer: string | undefined;
  let clientId: string | undefined;

  const base = rpiApiBase();
  if (base) {
    try {
      const res = await fetch(
        `${base}/api/v2/authentication/login-settings`,
        { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) },
      );
      if (res.ok) {
        const body = (await res.json()) as
          | Array<Record<string, unknown>>
          | { settings?: Array<Record<string, unknown>> };
        const settings = Array.isArray(body) ? body : (body.settings ?? []);
        const entry = settings.find(
          (s) => String(s.authenticationType ?? "").toUpperCase() === "OPENID",
        );
        if (entry) {
          // PUBLIC issuer only — NEVER entry.tokenEndpoint (cluster-internal).
          const iss = entry.openIDIssuer;
          if (typeof iss === "string" && iss.trim()) issuer = iss.trim();
          const cid = entry.clientID;
          if (typeof cid === "string" && cid.trim()) clientId = cid.trim();
        }
      }
    } catch {
      // Unreachable / timeout → fall through to env fallback.
    }
  }

  issuer = issuer ?? process.env.KEYCLOAK_SSO_ISSUER?.trim();
  clientId = clientId ?? process.env.KEYCLOAK_SSO_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  const normalizedIssuer = issuer.replace(/\/$/, "");
  return {
    issuer: normalizedIssuer,
    tokenEndpoint: tokenEndpointFor(normalizedIssuer),
    clientId,
  };
}

/**
 * Options for NextAuth's built-in Keycloak (OIDC) provider — the CORRECT SSO
 * path: authorization_code + PKCE (S256) redirect flow. This is a PUBLIC client,
 * so we send NO client_secret (`token_endpoint_auth_method: "none"`) and rely on
 * PKCE + state. NextAuth discovers authorize/token/jwks from `issuer`'s
 * .well-known document (type "oidc"). The scope requests an OIDC token that RPI
 * accepts directly and that stable-id metering keys to rpi:<stableId>.
 *
 * Extracted as a pure builder so it can be unit-tested without a live redirect.
 */
export function keycloakOidcOptions(issuer: string, clientId: string) {
  return {
    // Vendor-neutral provider id → callback path /api/auth/callback/sso. The
    // redirect flow can front ANY OIDC IdP (Keycloak, Entra, Okta, …), so the
    // route shouldn't say "keycloak". Behaviour is unchanged — same built-in
    // Keycloak provider, discovery, and PKCE; only the id/route is renamed.
    id: "sso",
    clientId,
    // PUBLIC client — deliberately NO clientSecret.
    issuer: issuer.replace(/\/$/, ""),
    client: { token_endpoint_auth_method: "none" as const },
    checks: ["pkce", "state"] as Array<"pkce" | "state">,
    authorization: { params: { scope: "openid profile email" } },
  };
}

/** The OIDC `account` fields NextAuth hands the jwt callback on redirect sign-in. */
export interface OidcAccountLike {
  access_token?: string;
  refresh_token?: string;
  /** Epoch SECONDS (OAuth2), unlike our internal rpiExpiresAt (epoch ms). */
  expires_at?: number;
}

/**
 * Map the OIDC redirect-flow `account` into the same rpi* session shape the
 * password grant produces, so everything downstream (X-RPI-Token forwarding,
 * lazy refresh keyed on rpiAuthSource, metering) is identical. `expires_at` is
 * epoch SECONDS per the OAuth2 spec; we convert to epoch ms. Falls back to a
 * conservative +60s when the provider omits it (forces an early refresh rather
 * than trusting an unknown lifetime). Returns null if there's no access token.
 */
export function mapKeycloakOidcAccount(
  account: OidcAccountLike | null | undefined,
): KeycloakSession | null {
  if (!account || typeof account.access_token !== "string") return null;
  return {
    rpiAccessToken: account.access_token,
    rpiRefreshToken: account.refresh_token,
    rpiExpiresAt:
      typeof account.expires_at === "number"
        ? account.expires_at * 1000
        : Date.now() + 60_000,
  };
}

function mapTokenResponse(data: KeycloakTokenResponse): KeycloakSession {
  return {
    rpiAccessToken: data.access_token,
    rpiRefreshToken: data.refresh_token,
    rpiExpiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Password (direct-access) grant against the discovered PUBLIC Keycloak token
 * endpoint. PUBLIC client — deliberately NO client_secret. Returns the mapped
 * rpi* session fields, or null on any failure (logged server-side).
 */
export async function keycloakPasswordGrant(
  username: string,
  password: string,
): Promise<KeycloakSession | null> {
  const sso = await discoverKeycloakSso();
  if (!sso) {
    console.error(
      "[keycloak-sso] no public Keycloak issuer/clientId discoverable (login-settings + env both empty)",
    );
    return null;
  }
  try {
    const res = await fetch(sso.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username,
        password,
        client_id: sso.clientId,
        scope: "openid",
        // PUBLIC client — NO client_secret on purpose.
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "<unreadable>"))
        .replace(/\s+/g, " ")
        .slice(0, 300);
      console.error(
        `[keycloak-sso] token endpoint rejected: ${res.status} ${res.statusText} — ${body}`,
      );
      return null;
    }
    return mapTokenResponse((await res.json()) as KeycloakTokenResponse);
  } catch (err) {
    console.error("[keycloak-sso] login failed:", err);
    return null;
  }
}

/**
 * Refresh-token grant against the discovered PUBLIC Keycloak endpoint (public
 * client, no secret). Returns the mapped rpi* fields, or null on failure so the
 * caller can drop the RPI session and fall back to re-login.
 */
export async function keycloakRefresh(
  refreshToken: string,
): Promise<KeycloakSession | null> {
  const sso = await discoverKeycloakSso();
  if (!sso) return null;
  try {
    const res = await fetch(sso.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: sso.clientId,
        // PUBLIC client — NO client_secret.
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "<unreadable>"))
        .replace(/\s+/g, " ")
        .slice(0, 200);
      console.error(
        `[keycloak-sso] refresh rejected: ${res.status} ${res.statusText} — ${body}`,
      );
      return null;
    }
    return mapTokenResponse((await res.json()) as KeycloakTokenResponse);
  } catch (err) {
    console.error("[keycloak-sso] refresh failed:", err);
    return null;
  }
}

/**
 * NextAuth callback path for the SSO OIDC provider (id "sso" — vendor-neutral;
 * the flow can front Keycloak/Entra/Okta/…). Auth.js computes the OAuth
 * redirect_uri as `<base>/api/auth/callback/sso` for BOTH the authorize and token
 * legs (base = AUTH_URL, else the request origin). So the ONLY reliable lever to
 * FORCE an exact, deterministic redirect_uri is the base URL (redirectProxyUrl
 * no-ops on same origin; an authorization.params override would desync the token
 * leg → the IdP's exact-match rejects it).
 */
export const SSO_CALLBACK_PATH = "/api/auth/callback/sso";

/**
 * Derive the NextAuth base URL (AUTH_URL) from the explicit
 * RPI_AI_AGENT_REDIRECT_URL. Returns the URL's origin (Auth.js re-appends
 * SSO_CALLBACK_PATH → the full redirect_uri), or undefined when the value is
 * absent/blank/not a valid absolute URL (→ caller falls back to origin-derived,
 * the pre-existing behavior). Pure + unit-testable.
 */
export function authUrlFromRedirect(redirectUrl: string | undefined): string | undefined {
  if (!redirectUrl || !redirectUrl.trim()) return undefined;
  try {
    return new URL(redirectUrl.trim()).origin;
  } catch {
    return undefined;
  }
}

/**
 * The redirect_uri Auth.js will actually send, given a base (AUTH_URL) origin —
 * the round-trip companion to authUrlFromRedirect. Used by tests to assert that a
 * standard RPI_AI_AGENT_REDIRECT_URL reconstructs to exactly itself.
 */
export function expectedRedirectUri(baseOrigin: string): string {
  return `${baseOrigin.replace(/\/$/, "")}${SSO_CALLBACK_PATH}`;
}
