/**
 * OIDC Discovery and JWKS-based JWT verification.
 *
 * Auto-detects OIDC configuration from RPI's login settings at startup.
 * When an OpenID provider is configured, creates a JWKS verifier for
 * fast local token validation without hitting RPI on every request.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import type { RPIAuthService, LoginSetting } from "./rpi-auth.js";

export interface OidcConfig {
  jwksUri: string;
  issuer: string;
  audience?: string;
}

export type OidcVerifyResult =
  | { valid: true; sub: string; claims: JWTPayload }
  | { valid: false };

export interface OidcVerifier {
  verifyToken(token: string): Promise<OidcVerifyResult>;
  readonly config: OidcConfig;
}

interface OpenIdDiscoveryDocument {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  [key: string]: unknown;
}

const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * Discover OIDC configuration from RPI's login settings.
 * Returns null if OIDC is not available or discovery fails.
 * Never throws — logs warnings and returns null on failure.
 */
export async function discoverOidcConfig(
  authService: RPIAuthService,
): Promise<OidcConfig | null> {
  try {
    const settings = await authService.getLoginSettings();
    const openIdEntry = settings.find(
      (s: LoginSetting) =>
        s.authenticationType === "OpenID" ||
        s.authenticationType === "OPENID",
    );

    if (!openIdEntry) {
      console.error("OIDC discovery: No OpenID entry found in login settings");
      return null;
    }

    // Extract issuer URL from known fields
    const issuerUrl =
      (openIdEntry.authorizationHost as string) ||
      (openIdEntry.openIDIssuer as string) ||
      (openIdEntry.authority as string) ||
      (openIdEntry.issuer as string);

    if (!issuerUrl) {
      console.error(
        "OIDC discovery: OpenID entry found but no issuer URL in fields (checked authorizationHost, openIDIssuer, authority, issuer)",
      );
      return null;
    }

    // Fetch .well-known discovery document
    const baseUrl = issuerUrl.replace(/\/$/, "");
    const discoveryDoc = await fetchDiscoveryDocument(baseUrl);

    if (!discoveryDoc) {
      return null;
    }

    const audience = (openIdEntry.audience as string) || undefined;

    const config: OidcConfig = {
      jwksUri: discoveryDoc.jwks_uri,
      issuer: discoveryDoc.issuer,
      audience,
    };

    console.error(
      `OIDC discovery: Found OpenID provider (issuer: ${config.issuer}, jwks: ${config.jwksUri})`,
    );

    return config;
  } catch (error) {
    console.error(
      `OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}. Falling back to RPI token validation.`,
    );
    return null;
  }
}

/**
 * Fetch the OpenID Connect discovery document.
 * Tries standard path (hyphen) first, then underscore variant used by some RPI deployments.
 */
async function fetchDiscoveryDocument(
  baseUrl: string,
): Promise<OpenIdDiscoveryDocument | null> {
  // Try standard OIDC path first
  const standardUrl = `${baseUrl}/.well-known/openid-configuration`;
  try {
    const response = await fetch(standardUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.ok) {
      return (await response.json()) as OpenIdDiscoveryDocument;
    }
  } catch {
    // Fall through to underscore variant
  }

  // Try underscore variant (used by some RPI/Keycloak deployments)
  const underscoreUrl = `${baseUrl}/.well-known/openid_configuration`;
  try {
    const response = await fetch(underscoreUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.ok) {
      return (await response.json()) as OpenIdDiscoveryDocument;
    }
  } catch {
    // Both failed
  }

  console.error(
    `OIDC discovery: Failed to fetch discovery document from ${standardUrl} or ${underscoreUrl}`,
  );
  return null;
}

/**
 * Create an OIDC token verifier from a discovered config.
 * Uses jose's createRemoteJWKSet which handles JWKS caching internally.
 */
export function createOidcVerifier(config: OidcConfig): OidcVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));

  return {
    config,
    async verifyToken(token: string): Promise<OidcVerifyResult> {
      try {
        const verifyOptions: {
          issuer?: string;
          audience?: string;
        } = {};
        if (config.issuer) verifyOptions.issuer = config.issuer;
        if (config.audience) verifyOptions.audience = config.audience;

        const { payload } = await jwtVerify(token, jwks, verifyOptions);

        return {
          valid: true,
          sub: (payload.sub as string) || "unknown",
          claims: payload,
        };
      } catch {
        return { valid: false };
      }
    },
  };
}
