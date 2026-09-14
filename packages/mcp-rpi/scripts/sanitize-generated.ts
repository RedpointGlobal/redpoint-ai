/**
 * Post-process for the generated OpenAPI types before they land in the committed,
 * public-repo file.
 *
 * The upstream spec embeds service-ish example addresses (apiuser@, no-reply@,
 * asdf@, cadc@ …@redpointglobal.com) as JSDoc `example`/`default` values. They are
 * not load-bearing for the emitted TypeScript types, but shipping a real corporate
 * address in a public repo is undesirable — so rewrite the Redpoint corporate
 * domains to example.com at the single point the file is produced. Every future
 * regen is therefore self-sanitizing.
 *
 * It also pins the spec's per-request-RANDOM dummy password example (`#Aa$<hex>`):
 * not a real credential (it changes on every fetch), but it is password-shaped in a
 * public file AND the sole source of regen non-determinism — pinning it means no
 * secret-shaped value ships and every regen is byte-identical, so
 * `generate:types:check` is a reliable drift canary.
 *
 * Pure + deterministic. GUID example values are left as-is: spec-authored,
 * indistinguishable from synthetic, and the value-leak gate proves none match our
 * live identifiers.
 */
export function sanitizeGeneratedTypes(source: string): string {
  return source
    .replaceAll("@redpointglobal.com", "@example.com")
    .replaceAll("@redpoint.net", "@example.com")
    .replace(/#Aa\$[0-9a-f]+/g, "#Aa$EXAMPLE");
}
