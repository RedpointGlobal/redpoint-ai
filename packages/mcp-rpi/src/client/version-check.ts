/**
 * API version-compatibility gate (coarse MAJOR.MINOR).
 *
 * mcp-rpi's tools are generated from the RPI Integration API OpenAPI spec at a
 * fixed version. A target instance whose MAJOR.MINOR differs may serve a drifted
 * tool surface (endpoints that 404, or missing ones). This is the FAST coarse gate;
 * the endpoint-mask (spec-fetch) does the FINE, per-tool trim. Both fail-open.
 *
 * Source of the instance version: the PUBLIC swagger.json's `info.version` (already
 * fetched by spec-fetch — one round-trip, no auth, no tenant scope). Verified live:
 * info.version reflects the running assembly (e.g. "7.7.0.0").
 */

/**
 * The MAJOR.MINOR mcp-rpi was BUILT AGAINST — the version of the OpenAPI spec the
 * generated types (rpi-api.generated.ts) come from. MUST be bumped in lockstep when
 * the types are regenerated against a newer spec (see `bun run generate:types:rpi`).
 */
export const BUILT_AGAINST_API_VERSION = "7.8";

/**
 * Extract "MAJOR.MINOR" from an RPI version string ("7.7.0.0" → "7.7", "7.7" → "7.7").
 * Returns null for anything without two leading numeric components (empty, garbage,
 * "v7", …) → the caller treats null as "unknown" (fail-open).
 */
export function parseMajorMinor(version: string | null | undefined): string | null {
  if (!version) return null;
  const m = version.trim().match(/^(\d+)\.(\d+)(?:[.\s].*)?$/);
  return m ? `${m[1]}.${m[2]}` : null;
}

export type VersionStatus = "match" | "mismatch" | "unknown";

/**
 * Compare a fetched instance version string to BUILT_AGAINST (MAJOR.MINOR).
 * Unparseable / absent → "unknown" (fail-open, never a hard failure).
 */
export function compareVersion(
  instanceVersion: string | null | undefined,
  builtAgainst: string = BUILT_AGAINST_API_VERSION,
): VersionStatus {
  const mm = parseMajorMinor(instanceVersion);
  if (mm === null) return "unknown";
  return mm === builtAgainst ? "match" : "mismatch";
}
