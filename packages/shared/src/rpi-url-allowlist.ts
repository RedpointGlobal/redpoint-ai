/**
 * SSRF guard for the per-request RPI "Environment Location" URL (Phase 1a).
 *
 * A per-request target URL that the server will connect to is an SSRF vector, so
 * every entry point that accepts one (apps/web login, apps/server middleware,
 * mcp-rpi middleware) MUST validate it against a host allowlist before use.
 *
 * Policy: the URL must be `https:` and its host must equal, or be a subdomain of,
 * an allowlisted registrable domain.
 *
 * SECURE BY DEFAULT + OSS-CLEAN: the default allowlist is EMPTY, so with no
 * `RPI_URL_ALLOWLIST` configured NO per-request URL is accepted (the per-request
 * Environment Location feature is OFF until a deployer opts in) and no vendor
 * domain is hardcoded in the shipped code. Set `RPI_URL_ALLOWLIST` (comma-
 * separated bare domains) to your RPI host domain(s) to enable it — e.g.
 * `RPI_URL_ALLOWLIST=your-company.com,internal-ops.example`. Backward-compat is
 * unaffected: with no `X-RPI-URL` sent, requests use the env RPI_INTEGRATION_API_URL
 * default, which the allowlist never gates.
 */

const DEFAULT_ALLOWLIST: string[] = [];

/** Parse RPI_URL_ALLOWLIST (comma-separated bare domains), else EMPTY. */
export function rpiUrlAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.RPI_URL_ALLOWLIST?.trim();
  if (!raw) return DEFAULT_ALLOWLIST;
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/**
 * True iff `raw` is a well-formed `https:` URL whose host equals, or is a
 * subdomain of, an allowlisted domain. Never throws.
 */
export function isAllowedRpiUrl(
  raw: string | undefined | null,
  allowlist: string[] = rpiUrlAllowlist(),
): boolean {
  if (!raw || typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return allowlist.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}
