/**
 * Exclusion config for the #27634 GET-tool generator.
 *
 * The RPI spec exposes 254 GET operations. This config CUTS 69 of them, leaving
 * **185 in-scope** GETs the generator will emit tools for (once the overlay names
 * them). The cuts are Mark-signed and split into named buckets so the intent is
 * auditable and a spec rename that silently un-cuts something trips the count
 * assertion (EXPECTED_IN_SCOPE) at build time.
 *
 * Buckets (65 domain cuts + 1 auth-plumbing + 3 action-shaped = 69):
 *   27  /jobs/results/*            — dead ends: need job IDs only POST /jobs/start/* produces
 *   19  modified-date/last-modified probes
 *    6  write-flow enums           — date-part-types, context-keys, json-message-types
 *    4  help/example routes
 *    4  QA/swagger routes
 *    5  mercury + published-content — unrecognized domains (Mark)
 *    1  /swagger/.well-known/openid-configuration — auth plumbing, excluded at wrap time
 *    3  action-shaped GETs         — GET verb but MUTATE state (cuz sweep #27634):
 *                                     data-connector /activate + /deactivate, maintenance /stop
 */

/** GETs remaining after exclusions. Build-time tripwire: the generator fails if the
 *  spec yields a different count without this constant being updated deliberately. */
export const EXPECTED_IN_SCOPE = 185;

// Each predicate matches on the spec path + operationId (both lowercased). Ordered
// buckets so a single op is attributed to exactly one reason (for reporting).
const EXCLUSION_BUCKETS: { name: string; match: (path: string, opId: string) => boolean }[] = [
  {
    name: "jobs-results",
    match: (p) => p.toLowerCase().includes("/jobs/results/"),
  },
  {
    name: "modified-date-probes",
    match: (p, o) =>
      /modified-date|last-modified|lastmodified|modifieddate/.test(`${p} ${o}`.toLowerCase()),
  },
  {
    name: "write-flow-enums",
    match: (p, o) =>
      /date-part-types|context-keys|json-message-types|datepart|contextkey|jsonmessagetype/.test(
        `${p} ${o}`.toLowerCase(),
      ),
  },
  {
    name: "help-example",
    match: (p, o) => /\/help|\/example|gethelp|getexample/.test(`${p} ${o}`.toLowerCase()),
  },
  {
    name: "qa-swagger",
    match: (p, o) => /\/qa|\/swagger|\.well-known/.test(`${p} ${o}`.toLowerCase()),
  },
  {
    name: "mercury-published-content",
    match: (p, o) =>
      /mercury|published-content|publishedcontent/.test(`${p} ${o}`.toLowerCase()),
  },
  {
    // Action-shaped GETs: declared GET but the endpoint MUTATES state (cuz sweep,
    // #27634). GET-only is the read-surface invariant, so these are cut. Matched by
    // path so an operationId rename can't silently re-admit them. See VERIFIED_READ
    // in generate-tools.ts (Guard 3) for verb-hits that ARE genuine reads.
    name: "action-shaped-gets",
    match: (p) =>
      /\/data-connector\/(activate|deactivate)$|\/maintenance\/stop$/.test(
        p.toLowerCase(),
      ),
  },
];

/** The excluding bucket name, or null if the GET is in-scope. */
export function exclusionReason(path: string, operationId: string): string | null {
  for (const b of EXCLUSION_BUCKETS) {
    if (b.match(path, operationId)) return b.name;
  }
  return null;
}

export function isExcluded(path: string, operationId: string): boolean {
  return exclusionReason(path, operationId) !== null;
}

/**
 * SUPPRESSED functional duplicates — GETs that remain IN-SCOPE but are deliberately
 * NOT emitted because a hand-written tool already serves the same purpose via a
 * different endpoint (so the path-based skip-set can't catch them). Keyed by the
 * spec's operationId with a one-line reason. Distinct from exclusions (still counted
 * in the 185 in-scope total) and from hand-covered (same endpoint). The generator
 * counts these as "suppressed" so the finish arithmetic is explicit:
 *   in-scope = authored + hand-covered + suppressed + awaiting.
 * All confirmed against the real hand tools (cuz to ratify at the audience domain).
 */
export const SUPPRESSED_DUPLICATES: Record<string, string> = {
  // get one audience definition by id — the hand get_audience_definition_by_id
  // already covers this (via the plural /audience-definitions + client-side filter).
  GetAudienceDefinition:
    "dup of hand get_audience_definition_by_id (/client/configuration/audience-definitions)",
  // get one audience definition by name — dup of hand get_audience_definition_by_name.
  GetAudienceDefinitionByName:
    "dup of hand get_audience_definition_by_name (/client/configuration/audience-definitions)",
  // get one client by id — dup of hand get_client_by_id (via plural
  // /cluster/operations/clients + client-side filter).
  GetClusterClient:
    "dup of hand get_client_by_id (/cluster/operations/clients)",
};

export function isSuppressedDuplicate(operationId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPRESSED_DUPLICATES, operationId);
}
