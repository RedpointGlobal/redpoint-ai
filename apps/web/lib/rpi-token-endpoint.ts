/**
 * RPI's OAuth token endpoint (`/connect/token`) for the login password grant.
 *
 * Its own module (not auth.ts) so it can be unit-tested without instantiating
 * NextAuth. Targets the per-request "Environment Location" (`rpiUrl`) when given
 * — so the login token-grant hits the RPI instance the rep selected — else the
 * configured RPI_INTEGRATION_API_URL default. The caller MUST SSRF-allowlist-
 * validate `rpiUrl` before passing it here. Returns null if neither is set.
 */
export function rpiTokenEndpoint(rpiUrl?: string): string | null {
  const raw = rpiUrl || process.env.RPI_INTEGRATION_API_URL;
  if (!raw) return null;
  const base = raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
  return `${base}/connect/token`;
}
