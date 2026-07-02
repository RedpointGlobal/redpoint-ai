/**
 * Scenario catalogue — TS (not JSON) so per-scenario predicates can be
 * code where needed. v1 ships routing/consistency + an ambiguous negative.
 * Predicate-with-cache scenarios (Bug D regression — age>20) follow in
 * v1.1; see plan.
 */

export interface Scenario {
  id: string;
  prompt: string;
  /** Expected dispatched skill, or `null` for ambiguous (clarifying-Q expected). */
  expectedSkill: string | null;
  /**
   * Final-text substring assertion (case-insensitive). Skipped if absent.
   * Case-insensitive by default so authors don't need to encode every
   * possible casing variant the LLM might produce.
   */
  textContains?: string;
  /** Light assertion: agent's text must be non-empty (defaults true for skilled scenarios). */
  textNonEmpty?: boolean;
  note?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "list-clients",
    prompt: "List my clients",
    expectedSkill: "rpi-clients",
    textNonEmpty: true,
  },
  {
    id: "list-audiences-no-count",
    prompt: "List my audiences",
    expectedSkill: "rpi-audiences",
    textNonEmpty: true,
    textContains: "audience",
    note: "Flag B negative control — no-count must stay on rpi-audiences",
  },
  {
    id: "audiences-with-counts-gt-0",
    prompt: "List audiences with counts greater than 0",
    expectedSkill: "rpi-selection-rules",
    textNonEmpty: true,
    textContains: "Count",
    note: "routing-fix regression guard",
  },
  {
    id: "list-selection-rules",
    prompt: "List my selection rules",
    expectedSkill: "rpi-selection-rules",
    textNonEmpty: true,
  },
  {
    id: "list-folders",
    prompt: "What folders do I have?",
    expectedSkill: "rpi-folders",
    textNonEmpty: true,
  },
  {
    id: "list-interactions",
    prompt: "List my interactions",
    expectedSkill: "rpi-interactions",
    textNonEmpty: true,
  },
  {
    id: "check-connection",
    prompt: "Verify RPI connection status",
    expectedSkill: "rpi-admin",
    textNonEmpty: true,
  },
  // v1.1.2 routing scenario (v1.1.2.1 scrub: 3 sibling scenarios dropped
  // because they targeted tools requiring entity-specific IDs the generic
  // prompts couldn't carry — agent's refusal to fabricate IDs was correct
  // behavior, not a regression). See README "Scenario design discipline".
  {
    id: "routing-admin-diagnostics",
    prompt: "Are there any errors in my RPI cluster?",
    expectedSkill: "rpi-admin",
    textNonEmpty: true,
    note: "Domain recognition — get_cluster_api_error_log lives ONLY in rpi-admin; no required params, agent CAN dispatch directly",
  },
  // v1.1.4 — 4 Tier-A scenarios (ID-free, read-only, workspace-portable).
  // Picked from a 45-tool audit: highest signal per scenario at lowest
  // cost. Tier B (chain extensions = coverage theater) and Tier C
  // (multi-step ID discovery = side-effect risk) deferred.
  {
    id: "routing-system-health",
    prompt: "Is my RPI system healthy?",
    expectedSkill: "rpi-admin",
    textNonEmpty: true,
    note: "Domain recognition — get_system_health_availability lives in rpi-admin; distinct path from verify_connection / get_cluster_api_error_log",
  },
  {
    id: "routing-audit-history",
    prompt: "Show me my RPI audit history",
    expectedSkill: "rpi-admin",
    textNonEmpty: true,
    note: "Domain recognition — get_cluster_audit_history lives in rpi-admin; 'audit history' has no skill noun, pure inference",
  },
  {
    id: "routing-audience-definitions",
    prompt: "Show me my audience definitions",
    expectedSkill: "rpi-audiences",
    textNonEmpty: true,
    note: "Sub-skill routing — list_audience_definitions vs list_audiences; definitions are a distinct path within rpi-audiences",
  },
  {
    id: "routing-selection-rule-definitions",
    prompt: "Show me my selection rule document definitions",
    expectedSkill: "rpi-selection-rules",
    textNonEmpty: true,
    note: "Sub-skill routing — list_basic_selection_rule_document_definitions vs list_selection_rules; distinct path within rpi-selection-rules",
  },
  {
    id: "routing-interaction-run-counts",
    prompt: "What were the result counts from the last run of my welcome interaction?",
    expectedSkill: "rpi-interactions",
    textNonEmpty: true,
    note: "Misrouting guard — interaction run-history counts route to rpi-interactions. Guards against the word 'counts' pulling to rpi-selection-rules (which owns count-predicate routing per audiences-with-counts-gt-0). Run-history counts ≠ selection-rule counts.",
  },
  {
    id: "routing-audience-via-interaction",
    prompt: "Which audience does my welcome interaction use?",
    expectedSkill: "rpi-interactions",
    textNonEmpty: true,
    note: "Misrouting guard — 'what audience does interaction X use' routes to rpi-interactions (the interaction is the entry point; the audience binding is discovered via the activity walk). Guards against the word 'audience' pulling to rpi-audiences.",
  },
  // Knowledge-intent scenarios — deep how-to / design / strategy questions must
  // dispatch to the dispatched knowledge expert (rpi-domain-expert), NOT be
  // answered inline and NOT route to an action skill. The 14 action/routing
  // scenarios above double as the negative control — none may regress onto
  // rpi-domain-expert now that it sits in the catalog.
  //
  // GROUNDING PAIR (the convert-don't-cull, now realized — the SME V1 body landed):
  //  - `knowledge-what-is-interaction` is the COVERED half: the expert now answers
  //    FROM the curated body (asserts a grounded token, not the old refusal).
  //  - `knowledge-out-of-scope-refusal` is the SURVIVING negative control: a topic
  //    the body does NOT cover, where the grounded expert must REFUSE not invent.
  // Together they prove grounding held across the content fill — covered → answers,
  // uncovered → refuses. (The old empty-body refusal assertion + its source-pin were
  // converted when the interim "not authored yet" decline block was removed.)
  {
    id: "knowledge-what-is-interaction",
    prompt: "What is an interaction in RPI?",
    expectedSkill: "rpi-domain-expert",
    textNonEmpty: true,
    textContains: "workflow",
    note: "GROUNDED-ANSWER half of the grounding pair (converted from the empty-body negative control when the SME V1 body landed). The expert now answers about interactions FROM the curated body — §7 frames an interaction as a workflow of activities, so a grounded answer contains 'workflow'. Pairs with knowledge-out-of-scope-refusal.",
  },
  {
    id: "knowledge-out-of-scope-refusal",
    prompt: "What are RPI's data ingestion and ETL pipeline best practices?",
    expectedSkill: "rpi-domain-expert",
    textNonEmpty: true,
    textContains: "curated",
    note: "OUT-OF-SCOPE NEGATIVE CONTROL — the surviving half of the convert-don't-cull pair. The curated body is campaign-building knowledge (attributes → rules → audiences → interactions → content); data ingestion / ETL is NOT covered, so the grounded expert must REFUSE ('not in your curated RPI knowledge' → contains 'curated') rather than invent. Guards that grounding holds AFTER the body is filled.",
  },
  {
    id: "knowledge-what-is-audience",
    prompt: "What is an audience?",
    expectedSkill: "rpi-domain-expert",
    textNonEmpty: true,
    note: "Definitional domain concept → rpi-domain-expert, not inline. Pairs with the no-count negative control (list-audiences-no-count) to prove definitional ≠ operation: 'what is an audience' = knowledge, 'list my audiences' = action.",
  },
  {
    id: "knowledge-build-retention-campaign",
    prompt: "How do I build a retention campaign in RPI?",
    expectedSkill: "rpi-domain-expert",
    textNonEmpty: true,
    note: "Knowledge intent (how-to / design) → dispatched knowledge expert, not an action skill. 'campaign' is domain knowledge, not an action-skill noun.",
  },
  {
    id: "knowledge-multiwave-design",
    prompt: "What's the best way to design a multi-wave campaign in RPI?",
    expectedSkill: "rpi-domain-expert",
    textNonEmpty: true,
    note: "Knowledge intent (design / strategy) → rpi-domain-expert. Guards that design-intent dispatches to knowledge rather than answering inline or pulling to an action skill.",
  },
];

/**
 * One-tier suite — N=1 across all scenarios. 2026-05-28 terminal reverse-port:
 * dropped full/stress + the smoke `ids` subset. Coverage > stochastic
 * statistical confidence at this gate. Humans never burst the same query
 * 5-10× in a minute; N>1 + a threshold gate (formerly 0.8) lets one-in-five
 * flakes pass averaged out. Single-N catches what would otherwise be
 * smoothed — fixes land at the underlying agent / SKILL.md instead.
 */
export const SCENARIO_RUN_COUNT = 1;

/**
 * v1.1.3 chain scenarios — name-prompted list→get-by-name flows.
 *
 * Each scenario:
 *   1. Pre-flight cache (`buildChainCache`) discovers the first record's
 *      name for the entity type.
 *   2. Prompt is parameterized with the discovered name.
 *   3. Path A assertion: agent dispatched to expected skill (existing
 *      pattern), agent's text mentions the cached name (entity-found),
 *      and `subAgentToolCalls` (v1.4 telemetry) contains a call whose
 *      tool name matches `expectedToolNamePattern` AND whose args include
 *      the cached name verbatim.
 *
 * Tool-name regex accepts both `_by_name` (direct path) and `_by_id`
 * (name → id resolve → by_id path). Either is correct; agent's choice.
 *
 * MCP tools are namespaced `rpi__<toolName>` per the MCP-client filter
 * in apps/server/src/mcp/client.ts. Patterns reflect that.
 *
 * Workspace-empty handling: if `buildChainCache` discovers no records of
 * a type, the scenario skips with `[skip: no <key> in workspace]`.
 */
export interface ChainScenario {
  id: string;
  /** Builds the user prompt from the cached name. */
  promptTemplate: (name: string) => string;
  expectedSkill: string;
  cacheKey: "clients" | "audiences" | "interactions" | "selectionRules";
  /** Matches the sub-agent tool name (e.g., `rpi__get_audience_by_(name|id)`). */
  expectedToolNamePattern: RegExp;
  note?: string;
}

export const CHAIN_SCENARIOS: ChainScenario[] = [
  {
    id: "chain-client-by-name",
    promptTemplate: (n) => `Show me the client named ${n}`,
    expectedSkill: "rpi-clients",
    cacheKey: "clients",
    expectedToolNamePattern: /^rpi__get_client_by_(name|id)$/,
  },
  {
    id: "chain-audience-by-name",
    promptTemplate: (n) => `Show me the audience named ${n}`,
    expectedSkill: "rpi-audiences",
    cacheKey: "audiences",
    expectedToolNamePattern: /^rpi__get_audience_by_(name|id)$/,
  },
  {
    id: "chain-interaction-by-name",
    promptTemplate: (n) => `Show me the interaction named ${n}`,
    expectedSkill: "rpi-interactions",
    cacheKey: "interactions",
    expectedToolNamePattern: /^rpi__get_interaction_by_(name|id)$/,
  },
  {
    id: "chain-selection-rule-by-name",
    promptTemplate: (n) => `Show me the selection rule named ${n}`,
    expectedSkill: "rpi-selection-rules",
    cacheKey: "selectionRules",
    // selection-rules splits get-by-id into Basic/Standard subtypes. Either
    // subtype's _by_id satisfies; _by_name is the single entry point.
    expectedToolNamePattern:
      /^rpi__get_(selection_rule_by_name|(basic|standard)_selection_rule_by_id)$/,
  },
];

/** 2026-05-28 one-tier reverse-port — return all chain scenarios at N=1. */
export function selectChainScenarios(): {
  scenarios: ChainScenario[];
  n: number;
} {
  return { scenarios: CHAIN_SCENARIOS, n: SCENARIO_RUN_COUNT };
}

/** 2026-05-28 one-tier reverse-port — return all routing scenarios at N=1. */
export function selectScenarios(): {
  scenarios: Scenario[];
  n: number;
} {
  return { scenarios: SCENARIOS, n: SCENARIO_RUN_COUNT };
}

