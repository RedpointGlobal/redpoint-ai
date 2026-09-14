import { normalizeEndpoint } from "../endpoint-path.js";

/** The two boot signals read from ONE swagger fetch. */
export interface InstanceSpec {
  /** Normalized served endpoint paths — input to the runtime tool mask. null = don't mask. */
  endpoints: Set<string> | null;
  /** The spec's `info.version` (runtime assembly version, e.g. "7.7.0.0") — input to the version gate. null = unknown. */
  version: string | null;
}

/**
 * Boot-time fetch of the running instance's OpenAPI spec. From ONE fetch it derives
 * BOTH boot signals: the served endpoint set (the tool mask) AND `info.version` (the
 * coarse MAJOR.MINOR version gate — see client/version-check.ts). The swagger is
 * PUBLIC (no auth, no tenant scope) and dynamically generated from the running
 * controllers, so its info.version reflects the live assembly.
 *
 * Fail-open by design: never throws. Each field is independently null on failure —
 * `endpoints:null` means "don't mask" (full superset stays registered); `version:null`
 * means "unknown" (no version gate). A total failure (unreachable/non-200/unparseable)
 * → both null.
 *
 * Fetched ONCE at module scope and cached; never per session (a ~4 MB / ~5 s fetch).
 */
export async function fetchInstanceSpec(baseUrl: string): Promise<InstanceSpec> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/swagger/v1/swagger.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { endpoints: null, version: null };
    const spec = (await res.json()) as {
      paths?: Record<string, unknown>;
      info?: { version?: unknown };
    };
    let endpoints: Set<string> | null = null;
    if (spec.paths && typeof spec.paths === "object") {
      const set = new Set<string>();
      for (const p of Object.keys(spec.paths)) set.add(normalizeEndpoint(p));
      endpoints = set.size > 0 ? set : null;
    }
    const version =
      typeof spec.info?.version === "string" ? spec.info.version : null;
    return { endpoints, version };
  } catch {
    return { endpoints: null, version: null };
  }
}
