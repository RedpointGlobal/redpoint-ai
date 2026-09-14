/**
 * SSRF guard for the per-request RPI "Environment Location" URL (Phase 1a).
 *
 * A local mirror of packages/shared/src/rpi-url-allowlist.ts — apps/web
 * deliberately does NOT import the @redpoint-ai/shared *package* (Next/webpack
 * workspace-package traversal hiccup; see lib/version.ts, lib/api.ts), so this
 * tiny copy keeps the login SSRF check self-contained. Keep in sync with shared.
 *
 * Secure-by-default: the allowlist is EMPTY unless RPI_URL_ALLOWLIST is set, so
 * the per-request-location feature is OFF (no vendor domain hardcoded) until a
 * deployer opts in.
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
