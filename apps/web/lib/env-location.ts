/**
 * Resolve a per-request "Environment Location" from a raw login credential/input,
 * shared by every credentials auth path (native RPI + SSO password grant).
 *
 * Three outcomes, deterministic:
 *   - `undefined` — absent/blank → fall to the env RPI_INTEGRATION_API_URL default
 *     (backward-compat; never a wrong instance).
 *   - `null`      — present but SSRF-REJECTED (non-allowlisted host or non-https)
 *     → the caller must FAIL the login (distinct "location not permitted" path),
 *     never silently connect elsewhere.
 *   - `string`    — a validated, allowlisted https URL to target.
 *
 * SSRF is delegated to the shared allowlist (empty by default → everything
 * rejected until RPI_URL_ALLOWLIST is configured).
 */
import { isAllowedRpiUrl } from "./rpi-url-allowlist";

export function resolveEnvLocation(raw: unknown): string | null | undefined {
  const url = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  if (url === undefined) return undefined;
  return isAllowedRpiUrl(url) ? url : null;
}

/**
 * Short-lived cookie that carries the selected Environment Location across the
 * SSO REDIRECT round-trip (the OIDC path can't pass a credential like the
 * password paths). It is ONLY an `rpiUrl` carrier — NOT an issuer selector; the
 * Keycloak issuer stays static/central. Set fresh (overwrite) per SSO attempt,
 * short TTL, HttpOnly + SameSite=Lax (Lax so it rides the top-level OAuth
 * callback navigation), cleared on the callback. A missing/expired/unreadable
 * cookie falls to the env default via `resolveEnvLocation` (fail-safe).
 */
export const ENV_LOCATION_COOKIE = "rpi_env_location";
export const ENV_LOCATION_COOKIE_MAX_AGE = 300; // seconds — short-lived carrier
