/**
 * Filter verbose fields out of RPI API responses to reduce LLM token usage.
 *
 * Ported from the Java RPI-MCPServer's `MCPResponseFilter`. Under `$metadata`,
 * only `validationIssues` is preserved — it carries actionable error info that
 * tool callers need. Opt out by passing `verbose=true` at the call site; the
 * body is then returned unchanged.
 */

export const FIELDS_TO_REMOVE: ReadonlySet<string> = new Set([
  "$jsonType",
  "$jsonTypeID",
  "data",
  "fileInfo",
]);

export const METADATA_FIELDS_TO_KEEP: ReadonlySet<string> = new Set([
  "validationIssues",
]);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function filterMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!isPlainObject(metadata)) return null;

  const kept: Record<string, unknown> = {};
  for (const field of METADATA_FIELDS_TO_KEEP) {
    if (!(field in metadata)) continue;
    const value = metadata[field];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    kept[field] = value;
  }

  return Object.keys(kept).length > 0 ? kept : null;
}

function filterElement(element: unknown): unknown {
  if (element === null || element === undefined) return element;
  if (Array.isArray(element)) return element.map(filterElement);
  if (!isPlainObject(element)) return element;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (FIELDS_TO_REMOVE.has(key)) continue;

    if (key === "$metadata") {
      const filtered = filterMetadata(value);
      if (filtered !== null) result[key] = filtered;
      continue;
    }

    result[key] = filterElement(value);
  }
  return result;
}

/**
 * Filter verbose fields from a response body. When `verbose` is true the body
 * is returned unchanged (reference-equal). Otherwise a new filtered value is
 * returned; the original is not mutated.
 */
export function filterResponse<T = unknown>(body: T, verbose: boolean): T {
  if (verbose) return body;
  return filterElement(body) as T;
}

/**
 * Rough estimate of token savings between an unfiltered and filtered body.
 * Uses the "~4 chars per token" heuristic from the Java implementation.
 * Returns 0 when either input is null/undefined.
 */
export function estimateTokenSavings(
  original: unknown,
  filtered: unknown,
): number {
  if (original == null || filtered == null) return 0;
  const originalChars = JSON.stringify(original).length;
  const filteredChars = JSON.stringify(filtered).length;
  return Math.max(0, Math.floor((originalChars - filteredChars) / 4));
}
