/**
 * Canonicalize an RPI endpoint path so build-time tool declarations and the
 * runtime instance spec compare on identical strings. THE ONE normalizer — used by
 * the runtime mask, the tools' `_meta.endpoints` stamps, and (later) the generator.
 *
 * - strips a leading `/api/v2` (the API client adds it; tool literals are post-prefix
 *   while spec paths carry it — both must align)
 * - drops any query string / fragment
 * - collapses every `{param}` template segment to `{}` so param-name differences
 *   (`{id}` vs `{interactionId}`) don't break the diff
 * - strips a trailing slash (except root)
 */
export function normalizeEndpoint(path: string): string {
  let p = path.trim();
  p = p.split("?")[0].split("#")[0];
  p = p.replace(/^\/api\/v2(?=\/|$)/, "");
  p = p.replace(/\{[^}]*\}/g, "{}");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}
