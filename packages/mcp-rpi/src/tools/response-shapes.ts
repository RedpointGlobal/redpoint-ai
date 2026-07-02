/**
 * Shared response-shaping helpers for MCP tool handlers.
 *
 * Two patterns applied across the toolset:
 *
 * 1. **Card mode on `list_*` tools**: the default response reduces each item
 *    to `{id, name, description}` plus optional per-domain extras. Lists are
 *    for picking, not for consuming full records. `verbose: true` at the tool
 *    level skips this step and returns the full RPI response.
 *
 * 2. **Oversize-field strip on selected `get_*` tools**: endpoints known to
 *    return very large records (audience-definitions today) strip specific
 *    heavy nested arrays by default. `verbose: true` returns them.
 *
 * Both helpers return new values and do not mutate their inputs.
 */

/** The card-shape minimum every list_* tool returns per item. */
export interface BaseCard {
  id?: unknown;
  name?: unknown;
  description?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce an item to the standard card fields plus any requested extras.
 * Missing fields come through as `undefined`; `JSON.stringify` omits them.
 */
export function toCard<T extends Record<string, unknown>>(
  item: T,
  extras: readonly string[] = [],
): Record<string, unknown> {
  const card: Record<string, unknown> = {
    id: item.id,
    name: item.name,
    description: item.description,
  };
  for (const field of extras) {
    card[field] = item[field];
  }
  return card;
}

/**
 * Produce a new response object where `body[envelopeKey]` is the array of
 * items mapped through `toCard`. The outer envelope (e.g. pageNumber,
 * pageSize, totalCount) is preserved as-is. If `body` doesn't have the
 * expected shape, it's returned unchanged (defensive).
 */
export function mapResultsToCards(
  body: unknown,
  envelopeKey: string,
  extras: readonly string[] = [],
): unknown {
  if (!isPlainObject(body)) return body;
  const raw = body[envelopeKey];
  if (!Array.isArray(raw)) return body;

  const mapped = raw.map((item) =>
    isPlainObject(item) ? toCard(item, extras) : item,
  );
  return { ...body, [envelopeKey]: mapped };
}

/**
 * Strip fields from a response by dotted path. Supports one level of nesting
 * (e.g. `"metadata.items"` removes `items` inside the `metadata` object but
 * leaves the rest of `metadata` intact). Top-level fields like
 * `"trainingSets"` remove the field from the root.
 *
 * Deeper paths are not currently needed by any caller; if a future field
 * requires depth > 1 we can extend.
 */
export function stripNestedFields<T>(body: T, paths: readonly string[]): T {
  if (!isPlainObject(body)) return body;
  const result: Record<string, unknown> = { ...body };

  for (const path of paths) {
    const [head, tail] = path.split(".", 2);
    if (tail === undefined) {
      // Top-level strip
      delete result[head];
      continue;
    }
    // One-level-deep strip: keep the container, remove the nested field.
    const container = result[head];
    if (isPlainObject(container)) {
      const cloned = { ...container };
      delete cloned[tail];
      result[head] = cloned;
    }
  }

  return result as T;
}
