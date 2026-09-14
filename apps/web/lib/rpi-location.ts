/**
 * Phase 1b — server-side signal for the "Environment Location" login field.
 *
 * The login page is a client component; whether RPI_URL_ALLOWLIST is configured
 * is server-side. This derives a SMALL, non-leaky payload for the client: an
 * is-enabled boolean and the env default URL (placeholder only) — never the
 * allowlist contents. An optional `url` probe returns whether that specific URL
 * is permitted, so the page can show an explicit "location not permitted"
 * message distinct from a credential failure.
 */
import { isAllowedRpiUrl, rpiUrlAllowlist } from "./rpi-url-allowlist";

export interface RpiLocationConfig {
  /** Feature enabled iff RPI_URL_ALLOWLIST is configured (non-empty). When false
   *  the login page must NOT render the field (unchanged single-instance login). */
  enabled: boolean;
  /** The env default RPI instance URL — shown as placeholder text only. "" if unset. */
  placeholder: string;
  /** For a probed `url`: whether it is allowlisted. `null` when no url was probed. */
  urlAllowed: boolean | null;
}

export function rpiLocationConfig(url?: string | null): RpiLocationConfig {
  const enabled = rpiUrlAllowlist().length > 0;
  const placeholder = process.env.RPI_INTEGRATION_API_URL?.trim() || "";
  const urlAllowed =
    typeof url === "string" && url.trim() ? isAllowedRpiUrl(url.trim()) : null;
  return { enabled, placeholder, urlAllowed };
}
