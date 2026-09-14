/**
 * MCP OAuth resource-server metadata (RFC 9728 Protected Resource Metadata +
 * the RFC 6750 WWW-Authenticate challenge) for external/retail MCP clients that
 * connect under AUTH_REQUIRED=true via standard MCP OAuth (discover → DCR →
 * PKCE → token → connect).
 *
 * DELIBERATE DESIGN DECISION — "soft audience" (Option A, confirmed by Mark
 * 2026-08-12; the Mechanism-A design flag):
 *   mcp-rpi is RPI's own gateway — it validates the caller's RPI token and
 *   FORWARDS it to the RPI Integration API for per-user RBAC (see
 *   middleware/auth.ts + the tool handlers' `extra.authInfo?.token`). The MCP
 *   spec's strict `aud == this-MCP-server` + no-passthrough rule guards a
 *   confused-deputy risk that does not exist in a single-trust-domain gateway
 *   (RPI token → RPI). So we advertise discovery and REUSE the existing
 *   aud-agnostic validation (JWKS with the RPI OIDC audience, then the
 *   validate-token-status fallback) — we do NOT enforce `aud == mcp-rpi`. This
 *   is intentional, not an oversight.
 *
 *   IF a real multi-backend / cross-resource need ever appears (mcp-rpi calling
 *   a DIFFERENT downstream on the user's behalf), the spec-pure path is RFC 8693
 *   token-exchange: accept an `aud == mcp-rpi` token, validate it strictly, then
 *   exchange it for a downstream-scoped token — that reintroduces the audience
 *   boundary without losing per-user identity. Not needed in this topology now.
 */
import type { HonoRequest } from "hono";

/** Scopes advertised to clients. Advisory — the RS does not enforce scopes
 *  (soft-aud model); a spec client requests these against the AS. */
export const DEFAULT_MCP_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
];

/**
 * The externally-reachable origin of this MCP server. Prefer RPI_MCP_PUBLIC_URL
 * (set it when behind a proxy/ingress whose public host differs); otherwise
 * derive from the request, honoring X-Forwarded-Proto/Host.
 */
export function serverOrigin(req: HonoRequest): string {
  const override = process.env.RPI_MCP_PUBLIC_URL;
  if (override) return override.replace(/\/+$/, "");
  const url = new URL(req.url);
  const proto = req.header("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.header("x-forwarded-host") || req.header("host") || url.host;
  return `${proto}://${host}`;
}

/** The canonical protected-resource identifier: this server's /mcp endpoint. */
export function mcpResourceUrl(req: HonoRequest): string {
  return `${serverOrigin(req)}/mcp`;
}

/** Absolute URL of the path-inserted PRM document (RFC 9728 §3.1). */
export function protectedResourceMetadataUrl(req: HonoRequest): string {
  return `${serverOrigin(req)}/.well-known/oauth-protected-resource/mcp`;
}

/** RFC 9728 Protected Resource Metadata document. `issuer` is the discovered
 *  RPI OIDC provider (the authorization server clients bootstrap against). */
export function buildProtectedResourceMetadata(
  req: HonoRequest,
  issuer: string,
): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(req),
    authorization_servers: [issuer],
    scopes_supported: DEFAULT_MCP_SCOPES,
    bearer_methods_supported: ["header"],
  };
}

/**
 * The RFC 6750 WWW-Authenticate challenge value pointing a client at the PRM so
 * it can (re)discover the authorization server. MUST be sent on every 401 so a
 * mid-session client whose token expired can re-bootstrap.
 */
export function wwwAuthenticateChallenge(req: HonoRequest): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(req)}", scope="${DEFAULT_MCP_SCOPES.join(" ")}"`;
}
