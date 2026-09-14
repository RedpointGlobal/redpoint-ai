/**
 * SSRF guard for the per-request RPI "Environment Location" URL (Phase 1a).
 *
 * mcp-rpi is a STANDALONE compiled binary with no @redpoint-ai/shared dependency
 * (deliberate — keeps the single-file binary portable), so this is a tiny local
 * mirror of packages/shared/src/rpi-url-allowlist.ts. Keep the two in sync.
 *
 * Policy: the URL must be `https:` and its host must equal, or be a subdomain of,
 * an allowlisted registrable domain. Default is EMPTY (secure-by-default +
 * OSS-clean: no vendor domain hardcoded; the per-request-location feature is OFF
 * until `RPI_URL_ALLOWLIST` — comma-separated bare domains — is configured).
 */

const DEFAULT_ALLOWLIST: string[] = [];

export function rpiUrlAllowlist(): string[] {
  const raw = process.env.RPI_URL_ALLOWLIST?.trim();
  if (!raw) return DEFAULT_ALLOWLIST;
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/** True iff `raw` is an https URL whose host is (a subdomain of) an allowlisted domain. */
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
  return allowlist.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
