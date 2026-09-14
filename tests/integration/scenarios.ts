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
  /**
   * Action-scenario tool-hit guard: when set, the run must show a sub-agent
   * tool call whose NAMESPACED name (e.g. `drh__drh_list_sources`) matches this
   * pattern. Proves routing reached the actual MCP tool — not just that the
   * skill was dispatched. Deterministic (exact tool name), unlike a text check.
   */
  expectedToolNamePattern?: RegExp;
  /**
   * Negative tool-hit guard: when set, the run must NOT show any sub-agent tool
   * call whose namespaced name matches this pattern. Proves a tool is *not*
   * performed (e.g. a plain connection check must not invoke the cluster-admin
   * health tool). Complements expectedToolNamePattern.
   */
  forbiddenToolNamePattern?: RegExp;
  /**
   * ORCHESTRATOR-tool routing guard (Phase 2, #27957). When set, the scenario is a
   * DIRECT orchestrator-tool decision, NOT a skill dispatch — the parent must call a
   * tool whose name matches this (e.g. `render_view_dashboard` for a dashboard
   * prompt, which Phase 2 routes deterministically rather than via a skill). Pair
   * with `expectedSkill: null` (no execute_skill expected). Guards the routing
   * DECISION (right tool + viewId); composition itself is deterministic, not gated.
   */
  expectedOrchestratorToolPattern?: RegExp;
  /** With `expectedOrchestratorToolPattern`: the called tool's `args.viewId` must equal this. */
  expectedViewId?: string;
  note?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "list-clients",
    prompt: "List my clients",
    expectedSkill: "rpi-admin",
    expectedToolNamePattern: /get_user_client_list/,
    textNonEmpty: true,
    note: "SEMANTIC (ii) 2026-08-15: 'my / list my clients' = the tenants the CALLER can access → rpi-admin/get_user_client_list (user-scoped, works per-user). Flipped from rpi-clients per Mark's ruling — possessive 'my clients' must not 403 for a non-cluster-admin. The all-tenants/cluster-wide path is covered by list-all-clients below.",
  },
  {
    id: "list-all-clients",
    prompt: "List all clients on the cluster",
    expectedSkill: "rpi-clients",
    expectedToolNamePattern: /list_clients/,
    textNonEmpty: true,
    note: "SEMANTIC (ii) 2026-08-15: explicit ALL-tenants / cluster-wide phrasing → rpi-clients/list_clients (the cluster-admin directory). Complements list-clients ('my clients' → rpi-admin) — guards the two intents from bleeding into each other.",
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
    id: "audiences-list-snapshots",
    prompt: "List my audience snapshots",
    expectedSkill: "rpi-audiences",
    expectedToolNamePattern: /list_audience_snapshots/,
    textNonEmpty: true,
    note: "Positive new-capability test (#27634, skill #10 — rpi-audiences +5 EXTEND) — proves the +5 snapshot/cell-list tools landed and the router REACHES rpi-audiences for a snapshot list (new snapshots op, list_audience_snapshots is a reliable list hit). A snapshot (frozen membership) is a THIRD concept distinct from the live file (list-audiences-no-count) and the definition (routing-audience-definitions), both of which remain the regression guard that menu-bloat didn't degrade existing routing.",
  },
  {
    id: "audiences-get-cell-list",
    prompt: "Get the cell list with id 66666666-6666-6666-6666-666666666666",
    expectedSkill: "rpi-audiences",
    expectedToolNamePattern: /get_cell_list/,
    textNonEmpty: true,
    note: "Deep new-capability test (#27634, skill #10) — a DISTINCT new sub-group (cell-list). Supplies an exact id so get_cell_list is the only correct target; covers the second orphan tool folded into rpi-audiences by the extend.",
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
    id: "attributes-list-attribute-lists",
    prompt: "List my attribute lists",
    expectedSkill: "rpi-attributes",
    expectedToolNamePattern: /list_attribute_lists/,
    textNonEmpty: true,
    note: "Positive adoption test (#27634) — proves the router can REACH rpi-attributes and hits list_attribute_lists, not just that it wasn't stolen. 'attribute lists' must land here, NOT rpi-selection-rules / rpi-audiences (which merely reference attribute lists).",
  },
  {
    id: "operations-execution-services",
    prompt: "List my execution services",
    expectedSkill: "rpi-operations",
    expectedToolNamePattern: /list_execution_services/,
    textNonEmpty: true,
    note: "Positive adoption test (#27634, skill #2) — proves the router REACHES rpi-operations and hits list_execution_services. Execution services are unique to rpi-operations (no confusable). Client-scoped ops here vs cluster-level diagnostics in rpi-admin.",
  },
  {
    id: "databases-list-databases",
    prompt: "List my databases",
    expectedSkill: "rpi-databases",
    expectedToolNamePattern: /list_databases/,
    textNonEmpty: true,
    note: "Positive adoption test (#27634, skill #3) — proves the router REACHES rpi-databases (the 22-tool watch-item) and the sub-agent picks list_databases (databases operation).",
  },
  {
    id: "databases-table-joins",
    prompt: "Show me my table joins",
    expectedSkill: "rpi-databases",
    expectedToolNamePattern: /list_table_joins/,
    textNonEmpty: true,
    note: "Intra-skill routing test (#27634, skill #3) — a DEEPER sub-group of the 22-tool rpi-databases. Proves operations narrowing works: 'table joins' reaches list_table_joins, not a database/sql-def tool. If this misroutes WITHIN the skill, that's the split signal.",
  },
  {
    id: "scv-list-views",
    prompt: "List my single customer views",
    expectedSkill: "rpi-single-customer-view",
    expectedToolNamePattern: /list_single_customer_views/,
    textNonEmpty: true,
    note: "Positive adoption test (#27634, skill #4) — proves the router REACHES rpi-single-customer-view and hits list_single_customer_views.",
  },
  {
    id: "scv-attribute-group-by-name",
    prompt: "Get the Demographics attribute group in the Customer360 single customer view",
    expectedSkill: "rpi-single-customer-view",
    expectedToolNamePattern: /get_single_customer_view_attribute_group_by_name/,
    textNonEmpty: true,
    note: "Intra-skill split test (#27634, skill #4), reframed — names BOTH the view (Customer360) and the specific group (Demographics), so get_single_customer_view_attribute_group_by_name is the ONLY correct target (the view-getter/list can't answer 'this named group'). Principle: a deep tool-hit prompt must supply the exact inputs only the target tool serves, else a broader tool is the correct pick and the pin is wrong.",
  },
  {
    id: "integrations-list-ftp",
    prompt: "List my FTP locations",
    expectedSkill: "rpi-integrations",
    expectedToolNamePattern: /list_ftp_locations/,
    textNonEmpty: true,
    note: "Positive adoption test (#27634, skill #5) — proves the router REACHES rpi-integrations (the 18-tool watch-item) and the sub-agent picks list_ftp_locations (ftp operation).",
  },
  {
    id: "integrations-web-publish",
    prompt: "List my web publish site maps",
    expectedSkill: "rpi-integrations",
    expectedToolNamePattern: /list_web_publish_site_maps/,
    textNonEmpty: true,
    note: "Intra-skill narrowing test (#27634, skill #5) — a DIFFERENT sub-group of the 18-tool rpi-integrations. Proves operations narrowing: 'web publish site maps' reaches list_web_publish_site_maps, not an ftp/channel/adapter tool. If this misroutes WITHIN the skill, that's the split signal.",
  },
  {
    id: "decision-rules-web-adaptors",
    prompt: "List the adaptors available to my web decision rules",
    expectedSkill: "rpi-decision-rules",
    expectedToolNamePattern: /list_web_decision_rule_adaptors/,
    textNonEmpty: true,
    note: "Positive + boundary test (#27634, skill #6, DECISION side) — a 'decision rule' prompt must land on rpi-decision-rules (decisioning), NOT rpi-selection-rules (segmentation). Hits list_web_decision_rule_adaptors. The SELECTION side is pinned by list-selection-rules (→ rpi-selection-rules) — both sides of the decision-vs-selection boundary guarded.",
  },
  {
    id: "decision-rules-orchestration-dynamic-content",
    prompt: "List the dynamic content files for my orchestration decision rules",
    expectedSkill: "rpi-decision-rules",
    expectedToolNamePattern: /list_orchestration_decision_rule_dynamic_content_files/,
    textNonEmpty: true,
    note: "Deep intra-skill narrowing (#27634, skill #6) — a DISTINCT sub-group (orchestration) of rpi-decision-rules; prompt supplies the exact target (orchestration dynamic-content) so list_orchestration_decision_rule_dynamic_content_files is the only correct tool, not web-adaptors/criteria. No runtime id needed (it's a paged catalog).",
  },
  {
    id: "analysis-crosstab-colors",
    prompt: "List the predefined colors for cross-tab analysis panels",
    expectedSkill: "rpi-analysis",
    expectedToolNamePattern: /get_cross_tab_analysis_panel_predefined_colors/,
    textNonEmpty: true,
    note: "Positive adoption test (#27634, skill #7) — proves the router REACHES rpi-analysis and hits get_cross_tab_analysis_panel_predefined_colors (a no-param catalog, so the tool-hit is reliable; panel-options sub-group).",
  },
  {
    id: "analysis-get-dashboard",
    prompt: "Get the dashboard with id 11111111-1111-1111-1111-111111111111",
    expectedSkill: "rpi-analysis",
    expectedToolNamePattern: /get_dashboard/,
    textNonEmpty: true,
    note: "Deep intra-skill narrowing (#27634, skill #7) — a DISTINCT sub-group (dashboards) of rpi-analysis. Prompt supplies the exact input the getter serves (a dashboard id), so get_dashboard is the only correct target, not a panel/report tool. Guards the internal spread (panels vs dashboards vs reports).",
  },
  {
    id: "content-list-image-assets",
    prompt: "List my digital image content-file assets",
    expectedSkill: "rpi-content",
    expectedToolNamePattern: /list_digital_image_content_file_assets/,
    textNonEmpty: true,
    note: "Positive adoption test (#27634, skill #8) — proves the router REACHES rpi-content and hits list_digital_image_content_file_assets (a paged list, so the tool-hit is reliable; digital-assets sub-group).",
  },
  {
    id: "content-googleads-offer",
    prompt: "Get the Google Ads Customer Match offer with id 22222222-2222-2222-2222-222222222222",
    expectedSkill: "rpi-content",
    expectedToolNamePattern: /get_googleads_customer_match_offer/,
    textNonEmpty: true,
    note: "Deep intra-skill + offer-disambiguation test (#27634, skill #8) — a DISTINCT sub-group (offers). Prompt names the Google Ads Customer Match offer type + supplies an id, so get_googleads_customer_match_offer is the only correct target, NOT the standard get_offer. Guards the get_offer-vs-googleads split cuz flagged.",
  },
  {
    id: "workflows-activity-results",
    prompt:
      "Get the activity results for workflow run instance 33333333-3333-3333-3333-333333333333, activity 44444444-4444-4444-4444-444444444444",
    expectedSkill: "rpi-workflows",
    expectedToolNamePattern: /get_workflow_activity_results/,
    textNonEmpty: true,
    note: "Positive adoption + workflows/interactions boundary (#27634, skill #9) — a specific RUN's per-activity telemetry, keyed by WorkflowAssociationInstanceID + ActivityID, is rpi-workflows (get_workflow_activity_results, activity sub-group). Pairs with routing-interaction-run-counts (interaction-centric run counts → rpi-interactions) to pin the workflows-vs-interactions boundary BOTH ways.",
  },
  {
    id: "workflows-association-logs",
    prompt:
      "Get the run log for workflow-association instance 55555555-5555-5555-5555-555555555555",
    expectedSkill: "rpi-workflows",
    expectedToolNamePattern: /get_workflow_association_instance_logs/,
    textNonEmpty: true,
    note: "Deep intra-skill test (#27634, skill #9) — a DISTINCT sub-group (logs). Names a workflow-ASSOCIATION instance run + supplies its WorkflowAssociationInstanceID, so get_workflow_association_instance_logs is the target (the run-level log, same key as the rest of the skill). Post-flip fix: the sibling get_workflow_instance_logs (orphan generic-ID key, unreachable in this skill's flow) was DROPPED from the filter to make the logs op structurally deterministic — no confusable coin-flip.",
  },
  {
    id: "list-folders",
    prompt: "What folders do I have?",
    expectedSkill: "rpi-folders",
    textNonEmpty: true,
  },
  {
    id: "folders-folder-contents",
    prompt:
      "List the contents of folder 77777777-7777-7777-7777-777777777777",
    expectedSkill: "rpi-folders",
    expectedToolNamePattern: /list_folder_content/,
    textNonEmpty: true,
    note: "Positive new-capability + intra-skill guard (#27634, skill #11 — rpi-folders +11 EXTEND). 'contents of ONE folder' (by id) → list_folder_content (folder op), distinct from list_folders (the whole tree — the existing list-folders scenario is the regression guard that the extend didn't degrade tree-browse routing).",
  },
  {
    id: "folders-file-metadata",
    prompt:
      "Get the file-system metadata for file 88888888-8888-8888-8888-888888888888",
    expectedSkill: "rpi-folders",
    expectedToolNamePattern: /get_file_metadata/,
    textNonEmpty: true,
    note: "Deep new-capability test (#27634, skill #11) — a DISTINCT sub-group (file-info). Names the file-SYSTEM metadata + supplies an id, so get_file_metadata is the target (metadata ABOUT the file, not its content — content is the domain skill).",
  },
  {
    id: "folders-file-dependents",
    prompt:
      "Which files depend on file 99999999-9999-9999-9999-999999999999?",
    expectedSkill: "rpi-folders",
    expectedToolNamePattern: /get_file_dependents/,
    textNonEmpty: true,
    note: "Deep new-capability + direction guard (#27634, skill #11) — file-dependencies op. 'what depends ON this file' = reverse/incoming → get_file_dependents, NOT get_file_dependencies (the opposite, forward direction). Pins the bidirectional pair.",
  },
  {
    id: "folders-file-info-attribute-lists",
    prompt: "List the file-info display-column attribute lists",
    expectedSkill: "rpi-folders",
    expectedToolNamePattern: /list_file_info_attribute_lists/,
    textNonEmpty: true,
    note: "Flagged cross-skill boundary (#27634, skill #11) — the FILE-INFO sense of 'attribute lists' → rpi-folders (list_file_info_attribute_lists), NOT the tenant-wide attribute lists which are rpi-attributes (list_attribute_lists, pinned by attributes-list-attribute-lists). cuz flagged the ×3-sense confusable; this pins the file-system sense. Prompt says 'file-info display-column' to disambiguate from the plain 'my attribute lists' that belongs to rpi-attributes.",
  },
  {
    id: "list-interactions",
    prompt: "List my interactions",
    expectedSkill: "rpi-interactions",
    textNonEmpty: true,
  },
  {
    id: "check-connection",
    prompt: "Check my RPI connection",
    expectedSkill: "rpi-admin",
    expectedToolNamePattern: /verify_connection/,
    forbiddenToolNamePattern: /get_cluster_|get_system_health_availability/,
    textNonEmpty: true,
    note: "INVARIANT (Mark, 2026-08-17): every SME (non-admin) MUST be able to check their connection cleanly. Uses Mark's exact failing phrasing. A connection check MUST call verify_connection (low-priv /info/version, per-user, never 403s) and MUST NOT touch any cluster-admin tool (get_cluster_* / get_system_health_availability). The earlier flakiness that made me drop the verify_connection positive assertion WAS the bug: the router passed operation='diagnostics', whose subset excluded verify_connection, so the sub-agent fell to get_cluster_api_error_log → 403 for non-admins. Fixed deterministically by making verify_connection a member of EVERY rpi-admin operation (structural, not phrase-match) + a description that makes it the unambiguous connectivity pick. This asserts BOTH halves; if a single run flips, the fix isn't deterministic.",
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
    expectedSkill: "rpi-health",
    expectedToolNamePattern: /get_system_health_availability/,
    textNonEmpty: true,
    note: "SYSTEM HEALTH → rpi-health (the 2026-08-16 split). Health tools moved OUT of rpi-admin into their own skill so a connection check (rpi-admin) structurally cannot call the health tool — makes check-connection's forbidden-tool assertion deterministic. Distinct from verify_connection (rpi-admin auth) / get_cluster_api_error_log (rpi-admin diagnostics).",
  },
  {
    id: "routing-audit-history",
    prompt: "Show me my RPI audit history",
    expectedSkill: "rpi-operations",
    expectedToolNamePattern: /get_operation_audit_history/,
    textNonEmpty: true,
    note: "Scope split (#27634 adoption): 'MY audit history' = CLIENT-scoped → rpi-operations (get_operation_audit_history). Superseded the old rpi-admin pin (that was a flagged 'pure inference' before a client-scoped audit skill existed). Pairs with routing-cluster-audit below.",
  },
  {
    id: "routing-cluster-audit",
    prompt: "Show me the cluster-wide audit history",
    expectedSkill: "rpi-admin",
    expectedToolNamePattern: /get_cluster_audit_history/,
    textNonEmpty: true,
    note: "Scope split (#27634 adoption): CLUSTER/system-wide audit → rpi-admin (get_cluster_audit_history). Pins the cluster half so the client-vs-cluster audit boundary is tested both ways, not just moved.",
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
    id: "selrules-standard-entire-rule-types",
    prompt:
      "What entire-rule types are available for building a standard selection rule?",
    expectedSkill: "rpi-selection-rules",
    expectedToolNamePattern: /list_standard_selection_rule_entire_rule_types/,
    textNonEmpty: true,
    note: "Positive new-capability test (#27634, skill #12 — rpi-selection-rules +1 EXTEND). The Standard 'entire rule' type catalog → list_standard_selection_rule_entire_rule_types (definitions op), a no-id catalog so the hit is reliable. Distinct from list_basic_selection_rule_document_definitions (the Basic analog, pinned by routing-selection-rule-definitions) — both live in rpi-selection-rules.",
  },
  {
    id: "userperm-list-users",
    prompt: "List the users configured in my tenant",
    expectedSkill: "rpi-users-permissions",
    expectedToolNamePattern: /list_users/,
    textNonEmpty: true,
    note: "Positive + client-vs-caller scope guard (#27634, skill #13 — rpi-users-permissions, three-user finale). The CLIENT tenant's user directory → rpi-users-permissions (list_users), NOT the caller's own identity (rpi-admin get_user_profile). Full 3-way caller/client/cluster scope pins land with the rpi-admin commit (#15); this is the client-side sanity.",
  },
  {
    id: "userperm-user-permissions",
    prompt: "What permissions does the user named Jane Smith have?",
    expectedSkill: "rpi-users-permissions",
    expectedToolNamePattern: /get_user_permissions/,
    textNonEmpty: true,
    note: "Deep intra-skill test (#27634, skill #13) — permissions op. Names a specific user → get_user_permissions (what one user actually has), distinct from list_available_permissions (the assignable catalog).",
  },
  {
    id: "cluster-list-users",
    prompt: "List the cluster-level users across all clients",
    expectedSkill: "rpi-cluster-users",
    expectedToolNamePattern: /list_cluster_users/,
    textNonEmpty: true,
    note: "Positive + cluster-vs-client scope guard (#27634 — rpi-cluster-users, the B1 split). CLUSTER users spanning clients → rpi-cluster-users (list_cluster_users), NOT one client's directory (rpi-users-permissions) and NOT the caller (rpi-admin). The cluster leg of the three-user scope triangle now points at rpi-cluster-users.",
  },
  {
    id: "cluster-external-users",
    prompt: "List the external federated cluster users",
    expectedSkill: "rpi-cluster-users",
    expectedToolNamePattern: /list_cluster_external_users/,
    textNonEmpty: true,
    note: "Deep intra-skill test (#27634 — rpi-cluster-users, B1 split) — external-users op. Federated/SSO cluster identities → list_cluster_external_users, distinct from the internal list_cluster_users. Both in the small 8-tool users skill.",
  },
  {
    id: "cluster-list-plugins",
    prompt: "What plugins are installed on the RPI cluster?",
    expectedSkill: "rpi-cluster-infra",
    expectedToolNamePattern: /list_cluster_plugins/,
    textNonEmpty: true,
    note: "The B1 FIX target (#27634) — this scenario flipped on the 13-tool rpi-cluster (sub-agent grabbed get_cluster_error_log for a plugins prompt when the router omitted the op). Fixed by the 2-way split PLUS dropping the two cluster-log magnet tools from the routed filter — rpi-cluster-infra is now a 3-noun magnet-free menu (system-tasks/aux-databases/plugins), so plugins hits list_cluster_plugins deterministically.",
  },
  {
    id: "cluster-system-tasks",
    prompt: "What cluster-wide system tasks are scheduled?",
    expectedSkill: "rpi-cluster-infra",
    expectedToolNamePattern: /get_cluster_system_tasks/,
    textNonEmpty: true,
    note: "Magnet-removal regression guard (#27634 — rpi-cluster-infra, B1 + disable-magnet). Cluster-wide system tasks → get_cluster_system_tasks. This flipped to get_cluster_error_log while the two cluster-log tools shared the menu; both were DROPPED from the routed filter (retail/direct only, like the #9 orphan-log drop), leaving a 3-noun magnet-free menu (system-tasks/aux-databases/plugins). Determinism > size — a magnet in the menu beats size, so the magnet was removed, not a third skill.",
  },
  {
    id: "admin-my-profile",
    prompt: "Show me my own user profile",
    expectedSkill: "rpi-admin",
    expectedToolNamePattern: /get_user_profile/,
    textNonEmpty: true,
    note: "THREE-WAY SCOPE PIN — CALLER leg (#27634, skill #15 — rpi-admin, three-user finale). 'MY own profile' = the authenticated caller → rpi-admin (get_user_profile). Completes the triangle with userperm-list-users (client → rpi-users-permissions) and cluster-list-users (cluster → rpi-cluster) — each of the three 'user' surfaces routes to its own skill, none bleeding to the other two.",
  },
  {
    id: "admin-my-clients",
    prompt: "Which clients can I access?",
    expectedSkill: "rpi-admin",
    expectedToolNamePattern: /get_user_client_list/,
    textNonEmpty: true,
    note: "New-capability + boundary vs rpi-clients (#27634, skill #15) — 'clients *I* can access' = the caller's reachable tenants → rpi-admin (get_user_client_list, identity op), distinct from rpi-clients (the full tenant list). Guards 'my clients' from bleeding to the tenant-listing skill.",
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
  {
    id: "runs-dashboard-pill",
    prompt: "Run daily interaction dashboard for last month...",
    // Phase 2 (#27957): dashboards route to the DETERMINISTIC render_view_dashboard
    // orchestrator tool, NOT a skill — so no execute_skill is expected.
    expectedSkill: null,
    expectedOrchestratorToolPattern: /render_view_dashboard/,
    expectedViewId: "interaction-run-counts",
    note: "Guards the routing of the LIVE SuggestionBar pill (seed.ts) 'Run daily interaction dashboard for last month...'. Phase 2 (#27957) replaced the old LLM-composed path (rpi-interactions → summarize_interaction_runs, granularity:'daily') with the deterministic render_view_dashboard tool. This pins the routing DECISION: the model must call render_view_dashboard with viewId 'interaction-run-counts' (the runs-over-time view) for a runs-dashboard prompt. Composition/params are deterministic code (not eval-gated); this guards only the tool + viewId choice — the coverage the skill-routing check can't see.",
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
export const SCENARIO_RUN_COUNT = Number(process.env.ACCURACY_EVALUATION_N || "1");

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
  // Optional subset runner — ACCURACY_EVALUATION_ONLY_IDS=id1,id2 restricts the
  // run to those scenario ids. Default (unset) → the full suite, unchanged. Lets
  // you re-confirm a specific scenario (e.g. an infra-flake casualty) in ~1 min
  // instead of the full ~13-min paced run. Mirrors the FORCE_FAIL_ID env pattern:
  // config via environment, nothing committed changes.
  const only = (process.env.ACCURACY_EVALUATION_ONLY_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scenarios = only.length
    ? SCENARIOS.filter((s) => only.includes(s.id))
    : SCENARIOS;
  return { scenarios, n: SCENARIO_RUN_COUNT };
}

/**
 * Data Readiness Hub routing scenarios — run ONLY against the "Data Readiness Hub" workspace (seeded
 * when Data Readiness Hub is configured: DRH_API_URL + DRH creds + the live mcp-drh server
 * on :3003). The routing.test.ts Data Readiness Hub block resolves that workspace by name
 * and SKIPS every scenario when it's absent, so these never fail a normal
 * single-workspace run. They exercise the full two-layer flow against the real
 * tools (the domain-expert now carries the SME-curated WHAT corpus):
 *   - knowledge intent  → drh-domain-expert (WHAT), which answers from the corpus
 *   - out-of-scope Q    → drh-domain-expert declines (proves the shared
 *                         GROUNDING_PREAMBLE injects for a SECOND expert)
 *   - operation intent  → drh-datasources (HOW), which calls a real drh__ tool
 * Every Data Readiness Hub turn additionally asserts NO rpi__ tool leak (cross-workspace
 * isolation) — enforced in the test, not per-scenario.
 */
export const DRH_SCENARIOS: Scenario[] = [
  {
    id: "drh-knowledge-what-is-datasource",
    prompt: "What is a data source in Data Readiness Hub?",
    expectedSkill: "drh-domain-expert",
    textNonEmpty: true,
    textContains: "source",
    note: "WHAT — definitional Data Readiness Hub concept → drh-domain-expert, which now answers from the curated corpus (§3 sources & feeds) → mentions 'source'.",
  },
  {
    id: "drh-knowledge-out-of-scope-refusal",
    prompt: "What are Data Readiness Hub's pricing and licensing tiers?",
    expectedSkill: "drh-domain-expert",
    textNonEmpty: true,
    textContains: "curated",
    note: "GROUNDING for a 2nd expert — pricing/licensing is NOT in the curated body, so the injected GROUNDING_PREAMBLE must make drh-domain-expert refuse ('not in ... curated knowledge' → contains 'curated').",
  },
  {
    id: "drh-op-list-datasources",
    prompt: "List my data sources",
    expectedSkill: "drh-datasources",
    textNonEmpty: true,
    // Tool-hit guard: the sub-agent must actually call a real Data Readiness Hub tool on the
    // Data Readiness Hub MCP connection — proves we hit the live server, not just that the
    // skill was picked. Namespaced drh__ (conn name) + the real drh_list_sources.
    expectedToolNamePattern: /^drh__drh_list_sources$/,
    note: "HOW — operation intent → drh-datasources action skill, which resolves a database then MUST call the real drh__drh_list_sources tool (tool-hit asserted, not inferred).",
  },
  {
    id: "drh-op-list-feeds",
    prompt: "List my feeds",
    expectedSkill: "drh-feeds",
    textNonEmpty: true,
    expectedToolNamePattern: /^drh__drh_list_feeds$/,
    note: "HOW — feed listing → drh-feeds → real drh__drh_list_feeds tool-hit.",
  },
  {
    id: "drh-op-list-match-runs",
    prompt: "Show me the recent match runs",
    expectedSkill: "drh-runs",
    textNonEmpty: true,
    expectedToolNamePattern: /^drh__drh_list_database_match_runs$/,
    note: "HOW — run reporting → drh-runs → real (database-scoped) drh__drh_list_database_match_runs tool-hit.",
  },
  {
    id: "drh-op-hygiene-scores",
    prompt: "What are my data hygiene scores?",
    expectedSkill: "drh-data-quality",
    textNonEmpty: true,
    expectedToolNamePattern: /^drh__drh_get_hygiene_scores$/,
    note: "HOW — data-quality metric → drh-data-quality → real drh__drh_get_hygiene_scores tool-hit.",
  },
  {
    id: "drh-op-list-schedules",
    prompt: "List my schedules",
    expectedSkill: "drh-schedules",
    textNonEmpty: true,
    expectedToolNamePattern: /^drh__drh_list_schedules$/,
    note: "HOW — schedule listing → drh-schedules → real drh__drh_list_schedules tool-hit.",
  },
];

/** Return all Data Readiness Hub stub scenarios at N=1 (mirrors selectScenarios). */
export function selectDrhScenarios(): {
  scenarios: Scenario[];
  n: number;
} {
  return { scenarios: DRH_SCENARIOS, n: SCENARIO_RUN_COUNT };
}

