/**
 * The OVERLAY for the #27634 GET-tool generator — hand-authored quality (names,
 * categories, descriptions) keyed by the spec's stable `operationId`. The generator
 * joins each in-scope GET to its overlay entry; a GET with no entry emits a
 * build-time "missing overlay" warning and no tool. Step 4+ authors the ~159
 * uncovered entries, one domain per commit; this ships a single SEED to prove the
 * pipeline.
 */
export interface OverlayEntry {
  /** MCP tool name (snake_case), e.g. "list_attribute_lists". */
  toolName: string;
  /** ToolCategory — must exist in TOOL_CATEGORIES + CATEGORY_DESCRIPTIONS. */
  category: string;
  /** Hand-written, DRH-quality description (the spec's are boilerplate). */
  description: string;
}

export const OVERLAY: Record<string, OverlayEntry> = {
  // --- SEED (Step 3): one uncovered in-scope GET, proving the emit pipeline. ---
  GetAttributeLists: {
    toolName: "list_attribute_lists",
    category: "configuration",
    description:
      "List the attribute lists configured in the RPI tenant. Attribute lists are reusable named sets of client-data attributes referenced by selection rules, audiences, and interactions; each entry returns its id, name, and description. Read-only.",
  },

  // --- Domain 1 (Step 4): authentication reads. ---
  GetUserProfile: {
    toolName: "get_user_profile",
    category: "auth",
    description:
      "Get the authenticated user's RPI profile — display name, username, email, and assigned roles/permissions for the token making the call. Use to confirm who the current credentials represent and what they're authorized to do. Read-only.",
  },
  GetUsersClientList: {
    toolName: "get_user_client_list",
    category: "auth",
    description:
      "List the RPI clients (tenants) the authenticated user can access, each with its id and name. Use to discover which X-ClientID values are valid for this user before scoping audience, interaction, or selection-rule calls to a specific client. Read-only.",
  },
  ValidateTokenStatus: {
    toolName: "validate_token_status",
    category: "auth",
    description:
      "Check whether the caller's RPI access token is currently valid (active, not expired or revoked). Use as a lightweight liveness/auth check before a longer sequence of calls. Read-only.",
  },

  // ======================================================================
  // Domain: configuration (Step 4). Grouped by CONFUSABLE CLUSTER (not
  // alphabetical) so sibling descriptions sit side-by-side for review — the
  // retail flat menu has no router, so each must disambiguate on its own.
  // ======================================================================

  // --- Cluster: attribute lists (a reusable NAMED SET OF ATTRIBUTES referenced
  //     by rules/audiences). Triple: by-id / by-name / list-all. The list form
  //     (GetAttributeLists → list_attribute_lists) is the Step-3 seed above. ---
  GetAttributeList: {
    toolName: "get_attribute_list",
    category: "configuration",
    description:
      "Get ONE attribute list by its ID, including the attributes it contains. An attribute list is a reusable named set of client-data attributes referenced by selection rules and audiences. Use when you already have the list's ID; to look it up by name use get_attribute_list_by_name, or list_attribute_lists to browse them all. Read-only.",
  },
  GetAttributeListByName: {
    toolName: "get_attribute_list_by_name",
    category: "configuration",
    description:
      "Get ONE attribute list by its exact name (case-sensitive), including the attributes it contains. Same record as get_attribute_list but keyed by name instead of ID — use when the user names the list rather than its ID. list_attribute_lists browses all of them. Read-only.",
  },

  // --- Cluster: cached attributes (attributes materialized/cached in the tenant
  //     for fast rule evaluation). Distinct from attribute LISTS above: this is
  //     the cache layer, not a named grouping. Triple: by-id / by-name / collection. ---
  GetCachedAttributes: {
    toolName: "get_cached_attributes",
    category: "configuration",
    description:
      "Get a single cached-attribute configuration by its ID. Cached attributes are client-data attributes materialized in RPI's cache for fast selection/audience evaluation — NOT the same as an attribute list (a named grouping); this is the cache definition. By name: get_cached_attributes_by_name; to list all: list_cached_attributes. Read-only.",
  },
  GetCachedAttributesByName: {
    toolName: "get_cached_attributes_by_name",
    category: "configuration",
    description:
      "Get a single cached-attribute configuration by its exact name. Same record as get_cached_attributes but keyed by name. Cached attributes are the cache layer for fast rule evaluation, distinct from attribute lists. list_cached_attributes returns all of them. Read-only.",
  },
  GetCachedAttributesCollection: {
    toolName: "list_cached_attributes",
    category: "configuration",
    description:
      "List all cached-attribute configurations in the tenant (id + name of each). The browse/index form for the cached-attributes cache layer; fetch one with get_cached_attributes (by ID) or get_cached_attributes_by_name. Read-only.",
  },

  // --- Cluster: managed basic lists (an admin-managed simple value list used by
  //     Basic selection rules). Distinct from attribute lists (attribute groupings)
  //     and value lists (allowed-value enums). Triple: by-id / by-name / list-all. ---
  GetManagedBasicList: {
    toolName: "get_managed_basic_list",
    category: "configuration",
    description:
      "Get one managed basic list by its ID, including its entries. A managed basic list is an admin-curated list of values used by Basic selection rules — distinct from an attribute list (attribute grouping) and a value list (allowed-value set). By name: get_managed_basic_list_by_name; browse all: list_managed_basic_lists. Read-only.",
  },
  GetManagedBasicListByName: {
    toolName: "get_managed_basic_list_by_name",
    category: "configuration",
    description:
      "Get one managed basic list by its exact name, including its entries. Same record as get_managed_basic_list keyed by name. Admin-curated list for Basic selection rules; list_managed_basic_lists returns all. Read-only.",
  },
  GetManagedBasicLists: {
    toolName: "list_managed_basic_lists",
    category: "configuration",
    description:
      "List all managed basic lists in the tenant (id + name of each). Browse/index form; fetch one with get_managed_basic_list (by ID) or get_managed_basic_list_by_name. Read-only.",
  },

  // --- Value lists (allowed-value sets / enumerations for attributes). List-only
  //     endpoint. Named 'list_' so it doesn't read as a single-record get. ---
  GetValueLists: {
    toolName: "list_value_lists",
    category: "configuration",
    description:
      "List the value lists configured in the tenant. A value list is a defined set of allowed/enumerated values for an attribute (e.g. valid status or region codes) — distinct from an attribute list (a grouping of attributes) and a managed basic list (values for Basic rules). Read-only.",
  },

  // --- Cluster: databases + keys + catalog (configured data sources). ---
  GetDatabases: {
    toolName: "list_databases",
    category: "configuration",
    description:
      "List all databases configured in the RPI tenant (id + name). A database is a configured data source RPI reads client data from. Fetch one's config with get_database, its schema with get_database_catalog. Read-only.",
  },
  GetDatabase: {
    toolName: "get_database",
    category: "configuration",
    description:
      "Get one configured database by its ID — its connection/config metadata (NOT its schema). For the tables/columns use get_database_catalog; to browse all use list_databases. Read-only.",
  },
  GetDatabaseCatalog: {
    toolName: "get_database_catalog",
    category: "configuration",
    description:
      "Get the CATALOG (schemas, tables, columns) of one database by its ID — the queryable structure. Distinct from get_database, which returns the database's connection config, not its schema. Read-only.",
  },
  GetDatabaseKeys: {
    toolName: "list_database_keys",
    category: "configuration",
    description:
      "List all database key definitions in the tenant. A database key defines the primary/matching key for a database's records. Fetch one by id (get_database_key) or name (get_database_key_by_name). Read-only.",
  },
  GetDatabaseKey: {
    toolName: "get_database_key",
    category: "configuration",
    description:
      "Get one database key definition by its ID. by-name: get_database_key_by_name; list all: list_database_keys. Distinct from get_database (the data source itself). Read-only.",
  },
  GetDatabaseKeyByName: {
    toolName: "get_database_key_by_name",
    category: "configuration",
    description:
      "Get one database key definition by its exact name. Same record as get_database_key keyed by name; list_database_keys returns all. Read-only.",
  },

  // --- Cluster: SQL database definitions (SQL-defined data sources). ---
  GetSqlDatabaseDefinitions: {
    toolName: "list_sql_database_definitions",
    category: "configuration",
    description:
      "List SQL database definitions in the tenant (full form). A SQL database definition is a data source defined by a SQL query rather than a physical table. For a lighter id/name index use list_sql_database_definitions_summary. Read-only.",
  },
  GetSqlDatabaseDefinitionsSummary: {
    toolName: "list_sql_database_definitions_summary",
    category: "configuration",
    description:
      "List SQL database definitions in SUMMARY form (id/name only) — the lightweight index vs the fuller list_sql_database_definitions. Use to browse before fetching one. Read-only.",
  },
  GetSqlDatabaseDefinition: {
    toolName: "get_sql_database_definition",
    category: "configuration",
    description:
      "Get one SQL database definition by its ID, including its SQL. by-name: get_sql_database_definition_by_name; for what it can be queried on use get_sql_database_definition_available_criterion. Read-only.",
  },
  GetSqlDatabaseDefinitionByName: {
    toolName: "get_sql_database_definition_by_name",
    category: "configuration",
    description:
      "Get one SQL database definition by its exact name. Same record as get_sql_database_definition keyed by name. Read-only.",
  },
  GetSqlDatabaseDefinitionAvailableCriterion: {
    toolName: "get_sql_database_definition_available_criterion",
    category: "configuration",
    description:
      "Get the available selection criteria (queryable fields/operators) for one SQL database definition by its ID — what you can build rules against. Distinct from get_sql_database_definition (the definition itself). Read-only.",
  },

  // --- Cluster: users, groups, permissions (tenant-config view of users; NOT the
  //     auth-identity get_user_profile). ---
  GetUsers: {
    toolName: "list_users",
    category: "configuration",
    description:
      "List the users configured in the RPI tenant (id + name). The tenant-administration view of users — distinct from get_user_profile (the auth identity of the current caller). Read-only.",
  },
  GetUserDetails: {
    toolName: "get_user_details",
    category: "configuration",
    description:
      "Get the current client user's configuration details including group memberships (pass OnlyActiveGroups=true to include only active groups). The config view of the caller — distinct from get_user_profile (auth identity/roles) and get_user_permissions (a named user's permissions). Read-only.",
  },
  GetUserGroups: {
    toolName: "list_user_groups",
    category: "configuration",
    description:
      "List all user groups in the tenant (id + name). User groups bundle users for permission assignment. Fetch one by id (get_user_group) or name (get_user_group_by_name). Read-only.",
  },
  GetUserGroup: {
    toolName: "get_user_group",
    category: "configuration",
    description:
      "Get one user group by its ID, including its members. by-name: get_user_group_by_name; list all: list_user_groups. Read-only.",
  },
  GetUserGroupByName: {
    toolName: "get_user_group_by_name",
    category: "configuration",
    description:
      "Get one user group by its exact name, including its members. Same record as get_user_group keyed by name. Read-only.",
  },
  GetUserPermissions: {
    toolName: "get_user_permissions",
    category: "configuration",
    description:
      "Get the permissions assigned to a specific user, identified by name. Distinct from list_available_permissions (the full catalog of assignable permissions) and get_user_details (the caller's own config). Read-only.",
  },
  GetUsersAvailablePermissions: {
    toolName: "list_available_permissions",
    category: "configuration",
    description:
      "List every permission that CAN be assigned to users in the tenant (the catalog). Distinct from get_user_permissions, which returns what one named user actually has. Read-only.",
  },

  // --- Cluster: FTP locations. ---
  GetFTPLocations: {
    toolName: "list_ftp_locations",
    category: "configuration",
    description:
      "List all FTP/SFTP locations configured in the tenant (id + name) — endpoints RPI reads/writes files to. Fetch one by id (get_ftp_location) or name (get_ftp_location_by_name). Read-only.",
  },
  GetFTPLocation: {
    toolName: "get_ftp_location",
    category: "configuration",
    description:
      "Get one FTP/SFTP location's configuration by its ID. by-name: get_ftp_location_by_name; list all: list_ftp_locations. Read-only.",
  },
  GetFTPLocationByName: {
    toolName: "get_ftp_location_by_name",
    category: "configuration",
    description:
      "Get one FTP/SFTP location's configuration by its exact name. Same record as get_ftp_location keyed by name. Read-only.",
  },

  // --- Cluster: web adapters. ---
  GetWebAdapters: {
    toolName: "list_web_adapters",
    category: "configuration",
    description:
      "List all web adapters configured in the tenant (id + name). A web adapter is a configured HTTP/web integration endpoint. Fetch one by id (get_web_adapter) or name (get_web_adapter_by_name). Read-only.",
  },
  GetWebAdapter: {
    toolName: "get_web_adapter",
    category: "configuration",
    description:
      "Get one web adapter's configuration by its ID. by-name: get_web_adapter_by_name; list all: list_web_adapters. Read-only.",
  },
  GetWebAdapterByName: {
    toolName: "get_web_adapter_by_name",
    category: "configuration",
    description:
      "Get one web adapter's configuration by its exact name. Same record as get_web_adapter keyed by name. Read-only.",
  },

  // --- Cluster: web publish site maps. ---
  GetWebPublishSiteMaps: {
    toolName: "list_web_publish_site_maps",
    category: "configuration",
    description:
      "List all web-publish site maps in the tenant (id + name). A site map configures a web-publishing destination's structure. Fetch one by id (get_web_publish_site_map) or name (get_web_publish_site_map_by_name). Read-only.",
  },
  GetWebPublishSite: {
    toolName: "get_web_publish_site_map",
    category: "configuration",
    description:
      "Get one web-publish site map by its ID. by-name: get_web_publish_site_map_by_name; list all: list_web_publish_site_maps. Read-only.",
  },
  GetWebPublishSiteMapByName: {
    toolName: "get_web_publish_site_map_by_name",
    category: "configuration",
    description:
      "Get one web-publish site map by its exact name. Same record as get_web_publish_site_map keyed by name. Read-only.",
  },

  // --- Cluster: table joins (simple = single-key, multiple = composite). ---
  GetTableJoins: {
    toolName: "list_table_joins",
    category: "configuration",
    description:
      "List all table-join definitions in the tenant (both simple and multiple). A table join relates two database tables for querying. Fetch a specific one with get_table_join_simple or get_table_join_multiple. Read-only.",
  },
  GetTableJoinSimple: {
    toolName: "get_table_join_simple",
    category: "configuration",
    description:
      "Get one SIMPLE table-join definition by its ID — a single-key join between two tables. Distinct from get_table_join_multiple (composite/multi-key). by-name: get_table_join_simple_by_name. Read-only.",
  },
  GetTableJoinSimpleByName: {
    toolName: "get_table_join_simple_by_name",
    category: "configuration",
    description:
      "Get one simple (single-key) table-join definition by its exact name. Same record as get_table_join_simple keyed by name. Read-only.",
  },
  GetTableJoinMultiple: {
    toolName: "get_table_join_multiple",
    category: "configuration",
    description:
      "Get one MULTIPLE table-join definition by its ID — a composite/multi-key join. Distinct from get_table_join_simple (single-key). by-name: get_table_join_multiple_by_name. Read-only.",
  },
  GetTableJoinMultipleByName: {
    toolName: "get_table_join_multiple_by_name",
    category: "configuration",
    description:
      "Get one multiple (composite-key) table-join definition by its exact name. Same record as get_table_join_multiple keyed by name. Read-only.",
  },

  // --- Cluster: single customer view (SCV) + its attribute groups. ---
  GetSingleCustomerViews: {
    toolName: "list_single_customer_views",
    category: "configuration",
    description:
      "List all single customer views (SCVs) in the tenant (id + name). An SCV is a unified customer data model spanning databases. Fetch one by id (get_single_customer_view) or name (get_single_customer_view_by_name). Read-only.",
  },
  GetSingleCustomerView: {
    toolName: "get_single_customer_view",
    category: "configuration",
    description:
      "Get one single customer view (SCV) by its ID, including its structure. by-name: get_single_customer_view_by_name; for a specific attribute group within it: get_single_customer_view_attribute_group. Read-only.",
  },
  GetSingleCustomerViewByName: {
    toolName: "get_single_customer_view_by_name",
    category: "configuration",
    description:
      "Get one single customer view (SCV) by its exact name. Same record as get_single_customer_view keyed by name. Read-only.",
  },
  GetSingleCustomerViewAttributeGroup: {
    toolName: "get_single_customer_view_attribute_group",
    category: "configuration",
    description:
      "Get one attribute group WITHIN a single customer view, identified by the view's ID plus the group's ResourceId. An attribute group organizes related attributes inside an SCV. by-name variant: get_single_customer_view_attribute_group_by_name. Read-only.",
  },
  GetCustomerViewAttributeGroupByName: {
    toolName: "get_single_customer_view_attribute_group_by_name",
    category: "configuration",
    description:
      "Get one attribute group within a single customer view, identified by the view's Name plus the group's ResourceName. Same record as get_single_customer_view_attribute_group keyed by names instead of IDs. Read-only.",
  },

  // --- Cluster: resolution levels (identity resolution tiers). ---
  GetResolutionLevels: {
    toolName: "list_resolution_levels",
    category: "configuration",
    description:
      "List all identity resolution levels in the tenant (id + name). A resolution level is a tier of identity matching (e.g. individual, household). Fetch one by id (get_resolution_level) or name (get_resolution_level_by_name). Read-only.",
  },
  GetResolutionLevel: {
    toolName: "get_resolution_level",
    category: "configuration",
    description:
      "Get one identity resolution level by its ID. by-name: get_resolution_level_by_name; list all: list_resolution_levels. Read-only.",
  },
  GetResolutionLevelByName: {
    toolName: "get_resolution_level_by_name",
    category: "configuration",
    description:
      "Get one identity resolution level by its exact name. Same record as get_resolution_level keyed by name. Read-only.",
  },

  // --- Cluster: seed definitions (seed/monitoring records). ---
  GetSeedDefinitions: {
    toolName: "list_seed_definitions",
    category: "configuration",
    description:
      "List all seed definitions in the tenant (id + name). A seed definition specifies seed records (test/monitoring addresses) injected into campaign outputs. Fetch one with get_seed_definition. Read-only.",
  },
  GetSeedDefinition: {
    toolName: "get_seed_definition",
    category: "configuration",
    description:
      "Get one seed definition by its ID, including its seed records. list all: list_seed_definitions. Read-only.",
  },

  // --- Cluster: channels (delivery/output destinations). ---
  GetChannels: {
    toolName: "list_channels",
    category: "configuration",
    description:
      "List the delivery channels configured in the tenant (id + name). A channel is an output/delivery destination (email, SMS, file export, etc.). For a data-extract channel's full config use get_data_extract_channel. Read-only.",
  },
  GetDataExtractChannel: {
    toolName: "get_data_extract_channel",
    category: "configuration",
    description:
      "Get one DATA-EXTRACT channel's configuration by its ID — a channel that exports selected data to a file/destination. Distinct from list_channels (all channels of every type). Read-only.",
  },

  // --- Cluster: configuration parameters (tenant settings). ---
  GetConfigurationParameters: {
    toolName: "list_configuration_parameters",
    category: "configuration",
    description:
      "List all configuration parameters (tenant-level settings) with their values. To fetch one by exact name use get_configuration_parameter; to find by partial name use search_configuration_parameters_by_name. Read-only.",
  },
  GetConfigurationParameter: {
    toolName: "get_configuration_parameter",
    category: "configuration",
    description:
      "Get one configuration parameter's value by its EXACT name. For partial-name matching use search_configuration_parameters_by_name; for all use list_configuration_parameters. Read-only.",
  },
  SearchConfigurationParametersByName: {
    toolName: "search_configuration_parameters_by_name",
    category: "configuration",
    description:
      "Search configuration parameters by a PARTIAL/substring name, returning all matches. Distinct from get_configuration_parameter (exact name, one) and list_configuration_parameters (all). Read-only.",
  },

  // --- Cluster: file attachment + file-type approval. ---
  GetConfigurationFileAttachment: {
    toolName: "get_configuration_file_attachment",
    category: "configuration",
    description:
      "Get metadata for one configuration file attachment by its ID (a file attached to a configuration object). Read-only.",
  },
  GetFileTypeApprovers: {
    toolName: "list_file_type_approvers",
    category: "configuration",
    description:
      "List the file-type approval configuration — which roles may approve which file types before use. Read-only.",
  },

  // --- Cluster: data-management column mappings. ---
  GetColumnMappingsSearch: {
    toolName: "search_column_mappings",
    category: "configuration",
    description:
      "Search database column mappings (paged via PageNumber/PageSize), filtering by DatabaseID, Schema, TableName, and/or ColumnName. Column mappings link a database's physical columns to RPI attributes. Read-only.",
  },

  // --- Cluster: audience snapshots (point-in-time frozen audience membership).
  //     Distinct from audience DEFINITIONS (structure) and audiences (live files). ---
  GetAudienceSnapshots: {
    toolName: "list_audience_snapshots",
    category: "configuration",
    description:
      "List all audience snapshots in the tenant (id + name). An audience snapshot is a point-in-time frozen membership of an audience — distinct from an audience definition (its structure) and the live audience file. Fetch one by id (get_audience_snapshot) or name (get_audience_snapshot_by_name). Read-only.",
  },
  GetAudienceSnapshot: {
    toolName: "get_audience_snapshot",
    category: "configuration",
    description:
      "Get one audience snapshot by its ID — a frozen point-in-time audience membership. by-name: get_audience_snapshot_by_name; list all: list_audience_snapshots. Read-only.",
  },
  GetAudienceSnapshotByName: {
    toolName: "get_audience_snapshot_by_name",
    category: "configuration",
    description:
      "Get one audience snapshot by its exact name. Same record as get_audience_snapshot keyed by name. Read-only.",
  },

  // ======================================================================
  // Domain: files (#27634). The CONTENT-FILE objects under /client/files/*
  // (decision rules, analysis panels, digital assets, offers, dashboards,
  // etc.) — distinct from "file-system" (folders/metadata). Grouped by
  // CONFUSABLE CLUSTER; the retail flat menu has no router, so each
  // description must disambiguate on its own.
  // ======================================================================

  // --- Cluster: decision rules (a rule that evaluates records against criteria
  //     to pick an outcome). The confusable axis is the rule's DATA SOURCE /
  //     target — database vs json vs web vs orchestration vs attribute-list.
  //     (The document-database variant is a hand tool; not repeated here.) ---
  GetDatabaseDecisionRule: {
    toolName: "get_database_decision_rule",
    category: "files",
    description:
      "Get one database decision rule by ID. A decision rule evaluates records against criteria to select an outcome; the DATABASE variant sources its criteria from a client database table. Sibling rules keyed by data source: json (get_json_decision_rule), web (get_web_decision_rule), orchestration (get_orchestration_decision_rule), attribute-list (get_attribute_list_decision_rule). Read-only.",
  },
  GetJsonDecisionRule: {
    toolName: "get_json_decision_rule",
    category: "files",
    description:
      "Get one JSON decision rule by ID — a decision rule whose input is a JSON message/payload (real-time / inbound decisioning) rather than a stored table. Siblings by source: database (get_database_decision_rule), web (get_web_decision_rule), orchestration (get_orchestration_decision_rule), attribute-list (get_attribute_list_decision_rule). Read-only.",
  },
  GetWebDecisionRule: {
    toolName: "get_web_decision_rule",
    category: "files",
    description:
      "Get one web decision rule by ID — a decision rule that fires on a website / web-channel interaction. Its available site connectors are listed by list_web_decision_rule_adaptors. Siblings: database, json, orchestration, attribute-list decision rules. Read-only.",
  },
  GetWebDecisionRuleAdaptors: {
    toolName: "list_web_decision_rule_adaptors",
    category: "files",
    description:
      "List the web adaptors (site/channel connectors) available to web decision rules. Catalog lookup — no ID. For a specific rule use get_web_decision_rule. Read-only.",
  },
  GetOrchestrationDecisionRule: {
    toolName: "get_orchestration_decision_rule",
    category: "files",
    description:
      "Get one orchestration decision rule by ID — the decision rule type used inside interaction/orchestration workflows to branch a customer journey. Its referenced dynamic-content files are paged by list_orchestration_decision_rule_dynamic_content_files. Siblings: database, json, web, attribute-list decision rules. Read-only.",
  },
  GetOrchestrationDecisionRuleDynamicContentFiles: {
    toolName: "list_orchestration_decision_rule_dynamic_content_files",
    category: "files",
    description:
      "List (paged, via PageNumber/PageSize) the dynamic-content files referenced by orchestration decision rules — the content assets such a rule can serve. For the rule itself use get_orchestration_decision_rule. Read-only.",
  },
  GetAttributeListDecisionRule: {
    toolName: "get_attribute_list_decision_rule",
    category: "files",
    description:
      "Get one attribute-list decision rule by ID — a decision rule that selects an outcome from an attribute list. This is the RULE, not the attribute list itself (get_attribute_list). Its usable attribute lists are given by list_attribute_list_decision_rule_lists. Siblings: database, json, web, orchestration decision rules. Read-only.",
  },
  GetAttributeListDecisionRuleLists: {
    toolName: "list_attribute_list_decision_rule_lists",
    category: "files",
    description:
      "List the attribute lists available for use inside attribute-list decision rules (catalog — no ID). Distinct from list_attribute_lists (every attribute list in the tenant); this is scoped to those valid as a decision-rule source. For the rule use get_attribute_list_decision_rule. Read-only.",
  },
  GetDecisionRuleAvailableCriterion: {
    toolName: "get_decision_rule_available_criterion",
    category: "files",
    description:
      "Get the criteria a given decision rule can be built on — the queryable attributes/fields available to decision rule ID. Use when composing or inspecting rule logic. The SQL-database-definition equivalent is get_decision_rule_available_sql_database_criterion. Read-only.",
  },
  GetAvailableSQLDatabaseDefinitionCriterion: {
    toolName: "get_decision_rule_available_sql_database_criterion",
    category: "files",
    description:
      "Get the criteria available to a decision rule sourced from a SQL database definition (ID = the SQL database definition). Companion to get_decision_rule_available_criterion, which is the generic (non-SQL-definition) form. Read-only.",
  },

  // --- Cluster: analysis panels (a saved analysis over client data). Confusable
  //     axis is the VISUALIZATION type — chart vs cross-tab vs venn — plus each
  //     panel's own aggregation/color sub-reads. ---
  GetChartAnalysisPanel: {
    toolName: "get_chart_analysis_panel",
    category: "files",
    description:
      "Get one chart analysis panel by ID — a saved chart-style analysis over client data. Its selectable aggregation functions come from get_chart_analysis_panel_available_aggregations. Sibling panels: cross-tab (get_cross_tab_analysis_panel), venn (get_venn_analysis_panel). Read-only.",
  },
  GetChartAnalysisPanelAvailableAggregations: {
    toolName: "get_chart_analysis_panel_available_aggregations",
    category: "files",
    description:
      "List the aggregation functions a chart analysis panel can apply for a given attribute (AttributeID) and function attribute (FunctionAttributeID). The cross-tab equivalent is get_cross_tab_analysis_panel_available_aggregations. Read-only.",
  },
  GetCrossTabAnalysisPanel: {
    toolName: "get_cross_tab_analysis_panel",
    category: "files",
    description:
      "Get one cross-tab (pivot) analysis panel by ID — a row/column cross-tabulation over client data. Its aggregations: get_cross_tab_analysis_panel_available_aggregations; its cell palette: get_cross_tab_analysis_panel_predefined_colors. Siblings: chart, venn analysis panels. Read-only.",
  },
  GetCrossTabAnalysisPanelAvailableAggregations: {
    toolName: "get_cross_tab_analysis_panel_available_aggregations",
    category: "files",
    description:
      "List the aggregation functions available to a cross-tab analysis panel for the given attribute (AttributeID) and function attribute (FunctionAttributeID). The chart equivalent is get_chart_analysis_panel_available_aggregations. Read-only.",
  },
  GetCrossTabAnalysisPanelPredefinedColors: {
    toolName: "get_cross_tab_analysis_panel_predefined_colors",
    category: "files",
    description:
      "List the predefined color palette available to cross-tab analysis panels (catalog — no ID), used to style pivot cells. Specific to cross-tab panels. Read-only.",
  },
  GetVennAnalysisPanel: {
    toolName: "get_venn_analysis_panel",
    category: "files",
    description:
      "Get one venn analysis panel by ID — an overlap/set analysis across audiences or segments. Siblings: chart (get_chart_analysis_panel), cross-tab (get_cross_tab_analysis_panel). Read-only.",
  },

  // --- Cluster: digital content assets (reusable content blocks for digital
  //     channels). Confusable axis is CONTENT TYPE — html vs text vs image —
  //     and, for images, single vs list. ---
  GetDigitalHtmlContentAsset: {
    toolName: "get_digital_html_content_asset",
    category: "files",
    description:
      "Get one digital HTML content asset by ID — a reusable HTML content block for digital/email channels. Sibling asset types: text (get_digital_text_content_asset), image file (get_digital_image_content_file_asset). Read-only.",
  },
  GetDigitalTextContentAsset: {
    toolName: "get_digital_text_content_asset",
    category: "files",
    description:
      "Get one digital TEXT content asset by ID — a reusable plain-text content block. Siblings: HTML (get_digital_html_content_asset), image file (get_digital_image_content_file_asset). Read-only.",
  },
  GetDigitalImageContentFileAsset: {
    toolName: "get_digital_image_content_file_asset",
    category: "files",
    description:
      "Get one digital IMAGE content-file asset by ID. To browse all image content-file assets use list_digital_image_content_file_assets. Sibling types: HTML, text content assets. Read-only.",
  },
  GetDigitalImageContentFileAssets: {
    toolName: "list_digital_image_content_file_assets",
    category: "files",
    description:
      "List (paged, via PageNumber/PageSize) the digital image content-file assets — the image library for digital channels. Fetch one by ID with get_digital_image_content_file_asset. Read-only.",
  },

  // --- Cluster: offers (a marketing offer served through interactions). Generic
  //     vs the GoogleAds Customer Match template variant. ---
  GetOffer: {
    toolName: "get_offer",
    category: "files",
    description:
      "Get one offer by ID — a marketing offer definition served through interactions/decisions. The Google Ads Customer Match template variant has its own reader: get_googleads_customer_match_offer. Read-only.",
  },
  GetGoogleAdsCustomerMatchTemplateOffer: {
    toolName: "get_googleads_customer_match_offer",
    category: "files",
    description:
      "Get one Google Ads Customer Match template offer by ID — the offer type that syncs an audience to a Google Ads Customer Match list. For a standard offer use get_offer. Read-only.",
  },

  // --- Cluster: dashboards & widgets (analysis display objects — a dashboard is
  //     an arrangement of widgets). ---
  GetClientDashboard: {
    toolName: "get_dashboard",
    category: "files",
    description:
      "Get one dashboard by ID — a saved arrangement of analysis widgets. Individual tiles are fetched with get_widget. Read-only.",
  },
  GetWidget: {
    toolName: "get_widget",
    category: "files",
    description:
      "Get one dashboard widget by ID — a single visualization tile (chart/metric) that lives on a dashboard (get_dashboard). Read-only.",
  },

  // --- Cluster: reports (aggregated results over a date range). ---
  GetChannelOverviewResults: {
    toolName: "get_channel_overview_results",
    category: "files",
    description:
      "Get channel overview report results for a channel over a date range — ChannelID plus StartDate/EndDate, optionally filtered by interaction, offer, or workflow association. Returns delivery/response metrics for the channel. Read-only.",
  },

  // --- Cluster: interaction-scoped file reads (content that hangs off an
  //     interaction/workflow rather than standing alone). ---
  GetDecisionOfferTestChannelFulfillmentStates: {
    toolName: "get_decision_offer_test_channel_fulfillment_states",
    category: "files",
    description:
      "Get the test channel fulfillment states for a decision-offer interaction (ID = the decision-offer file) — the simulated per-channel delivery states used when testing an offer decision. Read-only.",
  },
  GetDefaultParameters: {
    toolName: "get_data_process_default_parameters",
    category: "files",
    description:
      "Get the default parameter values for a data-process activity inside an interaction workflow — keyed by InteractionID + WorkflowAssociationID + DataProcessActivityID. Use before configuring or running that activity. Read-only.",
  },

  // --- Cluster: standalone file objects (each a distinct file type with no
  //     sibling to confuse it with; grouped for review, not disambiguation). ---
  GetCellList: {
    toolName: "get_cell_list",
    category: "files",
    description:
      "Get one cell list by ID — the matrix of cells (audience × offer/treatment combinations) used in campaign contact planning. Read-only.",
  },
  GetExportTemplate: {
    toolName: "get_export_template",
    category: "files",
    description:
      "Get one export template by ID — the reusable definition of columns and format for exporting audience or selection output. Read-only.",
  },
  GetModelProject: {
    toolName: "get_model_project",
    category: "files",
    description:
      "Get one predictive model project by ID — the container for a data-science model's configuration and outputs. Read-only.",
  },
  GetEntireStandardSelectionRuleTypesAndId: {
    toolName: "list_standard_selection_rule_entire_rule_types",
    category: "files",
    description:
      "List the advance 'entire rule' types and their IDs available when building a standard selection rule (catalog — no ID). For a specific standard selection rule use the get_standard_selection_rule_by_id tool. Read-only.",
  },

  // ======================================================================
  // Domain: cluster (#27634). Cluster-LEVEL administration reads (span all
  // clients) — users, external users, plugins, per-client auxiliary DBs, and
  // cluster logs/tasks. Complements the hand "admin" category (health, API
  // error log, audit history). Grouped by CONFUSABLE CLUSTER.
  //   SKIPPED (functional dup, flagged to cuz): GetClusterClient
  //   (/cluster/operations/client?ID=) — same purpose as the hand tool
  //   get_client_by_id (/cluster/operations/clients + client-side filter),
  //   different endpoint. Not authored, mirroring the GetAudienceDefinition skip.
  // ======================================================================

  // --- Cluster: cluster users. Confusable axis is INTERNAL (RPI-managed) vs
  //     EXTERNAL (federated/SSO) identity, each × list / by-id / by-name /
  //     profile / accessible-clients. ---
  GetClusterUsers: {
    toolName: "list_cluster_users",
    category: "cluster",
    description:
      "List all cluster-level RPI users — internal RPI-managed accounts defined at the cluster (spanning all clients), each with id and name. For federated/SSO identities use list_cluster_external_users. Fetch one by id (get_cluster_user) or name (get_cluster_user_by_name). Read-only.",
  },
  GetClusterUser: {
    toolName: "get_cluster_user",
    category: "cluster",
    description:
      "Get one cluster-level RPI user by ID — an internal account defined at the cluster. By name: get_cluster_user_by_name; its accessible clients: get_cluster_user_clients; its profile: get_cluster_user_profile. For a federated/external identity use get_cluster_external_user. Read-only.",
  },
  GetClusterUserByName: {
    toolName: "get_cluster_user_by_name",
    category: "cluster",
    description:
      "Get one cluster-level RPI user by exact name — the same record as get_cluster_user, keyed by name. Read-only.",
  },
  GetClusterUserProfile: {
    toolName: "get_cluster_user_profile",
    category: "cluster",
    description:
      "Get the profile (settings/roles at the cluster) of a NAMED cluster-level user by ID. This is a specific user's profile — NOT the authenticated caller's own profile, which is get_user_profile. Read-only.",
  },
  GetClusterUserClients: {
    toolName: "get_cluster_user_clients",
    category: "cluster",
    description:
      "List the RPI clients (tenants) a given cluster-level internal user (ID) can access. The external-user equivalent is get_cluster_external_user_clients. Read-only.",
  },
  GetClusterExternalUsers: {
    toolName: "list_cluster_external_users",
    category: "cluster",
    description:
      "List all EXTERNAL cluster users — federated/SSO identities rather than internal RPI accounts (list_cluster_users) — each with id and name. Fetch one by id: get_cluster_external_user. Read-only.",
  },
  GetClusterExternalUser: {
    toolName: "get_cluster_external_user",
    category: "cluster",
    description:
      "Get one EXTERNAL (federated/SSO) cluster user by ID. The internal-account equivalent is get_cluster_user; this external user's accessible clients: get_cluster_external_user_clients. Read-only.",
  },
  GetClusterExternalUserClients: {
    toolName: "get_cluster_external_user_clients",
    category: "cluster",
    description:
      "List the RPI clients an EXTERNAL (federated) cluster user (ID) can access. The internal-user equivalent is get_cluster_user_clients. Read-only.",
  },

  // --- Cluster: cluster operations (per-client databases + cluster logs/tasks).
  //     The three log/task reads differ by WHAT they record; each cross-refs the
  //     hand "admin" tools (get_cluster_api_error_log, get_cluster_audit_history). ---
  GetClusterClientAuxiliaryDatabases: {
    toolName: "get_cluster_client_auxiliary_databases",
    category: "cluster",
    description:
      "List the auxiliary databases configured for a cluster client/tenant (ID = the client) — the client's secondary data sources beyond its primary database. Read-only.",
  },
  GetClusterOperationManagementErrorLog: {
    toolName: "get_cluster_error_log",
    category: "cluster",
    description:
      "Get the cluster's GENERAL error log (paged via PageNumber/PageSize) — runtime errors across the cluster. For API-specific errors use get_cluster_api_error_log; for maintenance-job errors use get_cluster_housekeeping_log. Read-only.",
  },
  GetClusterOperationManagementHouseKeepingLog: {
    toolName: "get_cluster_housekeeping_log",
    category: "cluster",
    description:
      "Get the cluster's HOUSEKEEPING log — the record of maintenance/cleanup jobs (paged). Distinct from the general error log (get_cluster_error_log) and the API error log (get_cluster_api_error_log). Read-only.",
  },
  GetClusterOperationManagementSystemTasks: {
    toolName: "get_cluster_system_tasks",
    category: "cluster",
    description:
      "List the cluster's SYSTEM TASKS — background/scheduled cluster-wide jobs and their state (paged). Cluster scope; the client-scoped system tasks are a separate operations-domain read. Read-only.",
  },

  // --- Cluster: plugins. ---
  GetClusterPlugins: {
    toolName: "list_cluster_plugins",
    category: "cluster",
    description:
      "List the plugins/extensions installed on the RPI cluster, each with id and name. Read-only.",
  },

  // ======================================================================
  // Domain: data-connectors (#27634). Reads for data-connector syncs (client
  // scope). The activate/deactivate ACTIONS are excluded (action-shaped GETs).
  // ======================================================================
  GetListSynchDefinition: {
    toolName: "get_data_connector_sync_definition",
    category: "data-connectors",
    description:
      "Get one data-connector sync definition by ID — the configuration of a connector sync (what data flows to which external destination). For live run status use list_data_connector_sync_info. The activate/deactivate actions are intentionally not exposed on this read-only surface. Read-only.",
  },
  GetListSyncInfo: {
    toolName: "list_data_connector_sync_info",
    category: "data-connectors",
    description:
      "List data-connector sync status/info for a given workflow association (WorkflowAssociationID) — the run state of connector syncs. For a sync's configuration use get_data_connector_sync_definition. Read-only.",
  },

  // ======================================================================
  // Domain: file-system (#27634). The FILING metadata around stored files —
  // a file's own metadata/history/dependencies (category "file-system") and the
  // folder/path tree that contains them (category "folders"). Reuses the two
  // existing hand categories, NOT a new one.
  //
  // THREE-WAY BOUNDARY (draw it in every description):
  //   - "files" domain = the file's CONTENT (rules, panels, assets, offers).
  //   - "file-system" = metadata/relationships ABOUT a file of ANY type.
  //   - "folders" = the containers/path tree, not the files themselves.
  // Hand tools already here: get_file_info_by_id (the GUID→card resolver) and
  // list_folders (the tree) — cross-ref them, don't duplicate them.
  // ======================================================================

  // --- Cluster: file-info aspects (metadata ABOUT a stored file, keyed by ID).
  //     Confusable axis: WHICH aspect — metadata vs history vs dependency
  //     DIRECTION (dependents vs dependencies). ---
  GetMetadata: {
    toolName: "get_file_metadata",
    category: "file-system",
    description:
      "Get the metadata record for a stored file by its ID — the file-system properties of a file of ANY type (audience, interaction, rule, offer, …). This is metadata ABOUT the file, NOT its content (fetch content via the domain tool, e.g. get_offer / get_audience_by_id) and NOT the basic name/type/folder card (that's the get_file_info_by_id hand tool). Read-only.",
  },
  GetFileHistory: {
    toolName: "get_file_history",
    category: "file-system",
    description:
      "Get the change history of a stored file by its ID — its edit/version trail. Companion to get_file_metadata (current properties) and the get_file_info_by_id hand tool (the name/type/folder card). Read-only.",
  },
  GetDependenciesOnFile: {
    toolName: "get_file_dependents",
    category: "file-system",
    description:
      "List the files that depend ON a given file (ID) — what references it and would be affected if it changed (incoming / reverse dependencies). Pass IncludeLooseDependencies to include indirect references. The OPPOSITE direction — what this file itself depends on — is get_file_dependencies. Read-only.",
  },
  GetFileDependencies: {
    toolName: "get_file_dependencies",
    category: "file-system",
    description:
      "List the files a given file (ID) depends ON — its own inputs/references (outgoing / forward dependencies). The OPPOSITE direction — what depends on this file — is get_file_dependents. Read-only.",
  },
  GetFileAttributeLists: {
    toolName: "list_file_info_attribute_lists",
    category: "file-system",
    description:
      "List the attribute lists available in the file-system file-info context (e.g. selectable as file-info display columns) — a catalog, no ID. Distinct from list_attribute_lists (every attribute list in the tenant — configuration domain) and from list_attribute_list_decision_rule_lists (files domain). Read-only.",
  },
  SearchExternalFoldersConnectorDetails: {
    toolName: "search_external_folder_connectors",
    category: "file-system",
    description:
      "Search external-folder connector details by name or ID (NameOrID) — the storage connectors (e.g. cloud/SFTP endpoints) that back external folders. External-storage connector infrastructure, distinct from the internal browsable folder tree (folders category). Read-only.",
  },

  // --- Cluster: folder reads (containers in the path tree). Confusable axis:
  //     by-id vs by-full-path, and folder PROPERTIES vs CONTENTS vs PERMISSIONS.
  //     Cross-ref the list_folders hand tool (the whole tree).
  //     SKIPPED (PERMANENT — ratified by Mark 2026-08-08; do NOT re-derive):
  //     GetFolder (GET /client/file-system/folder) — its PATH is owned by the hand
  //     create_folder (POST same path). The skip-set is method-agnostic (plain
  //     normalized-path matching) BY DESIGN and stays that way: guards stay
  //     deterministic; anything a guard suppresses that we genuinely want comes
  //     back via hand-authoring, never by softening the guard. So there is NO
  //     folder-by-id read — use get_folder_by_full_path, or resolve a file's folder
  //     from the get_file_info_by_id card / list_folders. ---
  GetFolderByFullPath: {
    toolName: "get_folder_by_full_path",
    category: "folders",
    description:
      "Get one folder by its full path string (e.g. '/Audiences/MW') — the folder's properties (name, parent, path). Folders are readable by full path only; there is no folder-by-ID read — resolve a file's folder from the get_file_info_by_id card, or browse the tree with list_folders. Read-only.",
  },
  GetFolderContent: {
    toolName: "list_folder_content",
    category: "folders",
    description:
      "List the CONTENTS of a folder (ID) — the files and subfolders directly inside it. Distinct from the list_folders hand tool (which walks the whole folder TREE); for a folder's own properties use get_folder_by_full_path. Read-only.",
  },
  GetFolderPermissions: {
    toolName: "get_folder_permissions",
    category: "folders",
    description:
      "Get the access permissions on a folder by its ID — which users/groups can see/use it. By path instead: get_folder_permissions_by_full_path. Read-only.",
  },
  GetFolderPermissionsByFullPath: {
    toolName: "get_folder_permissions_by_full_path",
    category: "folders",
    description:
      "Get the access permissions on a folder by its full path — the same as get_folder_permissions, keyed by path. Read-only.",
  },
  GetUserPrivateFolder: {
    toolName: "get_user_private_folder",
    category: "folders",
    description:
      "Get the authenticated user's private (home) folder — the personal folder for the current caller. No ID. Read-only.",
  },

  // ======================================================================
  // Domain: workflows (#27634). Runtime execution TELEMETRY for a workflow run
  // (a "workflow-association instance") and its activities — logs, results,
  // assets, SQL traces, summaries. Category "workflows". Complements (does not
  // duplicate) the hand tools that report workflow STATUS/SUMMARY, which live in
  // the interactions/audiences categories and are cross-referenced below.
  //
  // Guard suppressions in this domain (hand-owned; NOT authored): activity-status
  // (get_audience_workflow_activity_status), blocks-instance-results plural
  // (get_audience_workflow_block_results), audience test-instances
  // (list_audience_test_instances), instance summary singular
  // (get_workflow_instance_summary), interaction all-instances
  // (get_interaction_workflow_instances).
  // ======================================================================

  // --- Cluster: activity-level reads (ONE activity in a run; keyed by
  //     WorkflowAssociationInstanceID + ActivityID). Axis: WHICH artifact of the
  //     activity run — results vs log vs assets vs SQL trace. ---
  GetWorkflowsActivityResults: {
    toolName: "get_workflow_activity_results",
    category: "workflows",
    description:
      "Get the RESULTS/output of a single activity (ActivityID) within a workflow run (WorkflowAssociationInstanceID) — the data that activity produced. Same activity, other artifacts: log (get_workflow_activity_log), assets (get_workflow_activity_assets), SQL trace (get_workflow_activity_sql_trace). For results across ALL activities of the run: get_workflow_all_activity_results. Read-only.",
  },
  GetWorkflowsActivityLog: {
    toolName: "get_workflow_activity_log",
    category: "workflows",
    description:
      "Get the execution LOG of a single activity (ActivityID) within a workflow run (WorkflowAssociationInstanceID) — its run messages/timeline. Same activity, other artifacts: results / assets / SQL trace. For the whole run's log use get_workflow_association_instance_logs. Read-only.",
  },
  GetWorkflowsActivityAssets: {
    toolName: "get_workflow_activity_assets",
    category: "workflows",
    description:
      "Get the ASSETS produced by a single activity (ActivityID) within a workflow run (WorkflowAssociationInstanceID) — the files/outputs it generated. Same activity, other artifacts: results / log / SQL trace. Read-only.",
  },
  GetWorkflowsActivitySQLTrace: {
    toolName: "get_workflow_activity_sql_trace",
    category: "workflows",
    description:
      "Get the SQL TRACE of a single activity (ActivityID) within a workflow run (WorkflowAssociationInstanceID) — the SQL it executed, for debugging. Same activity, other artifacts: results / log / assets. Read-only.",
  },

  // --- Cluster: instance-level reads (the whole workflow run). ---
  GetWorkflowInstancesAllActivityResults: {
    toolName: "get_workflow_all_activity_results",
    category: "workflows",
    description:
      "Get the results of ALL activities in a workflow run (WorkflowAssociationInstanceID) — every activity's output in one call. For a single activity use get_workflow_activity_results. Read-only.",
  },
  GetWorkflowsInstanceSummaries: {
    toolName: "list_workflow_instance_summaries",
    category: "workflows",
    description:
      "List the per-activity summaries for a workflow run (WorkflowAssociationInstanceID / ActivityID) — status/counts per activity. Distinct from the get_workflow_instance_summary hand tool (the single run-level summary). Read-only.",
  },

  // --- Cluster: run logs. Axis: association-instance-scoped vs
  //     workflow-instance-scoped (subtle — each names its key + scope). ---
  GetWorkflowAssociationInstanceLogs: {
    toolName: "get_workflow_association_instance_logs",
    category: "workflows",
    description:
      "Get the logs for a whole workflow-association instance (WorkflowAssociationInstanceID) — the run-level log across the workflow. For a single activity's log use get_workflow_activity_log; for the workflow-instance-scoped log use get_workflow_instance_logs. Read-only.",
  },
  GetWorkflowInstanceLogs: {
    toolName: "get_workflow_instance_logs",
    category: "workflows",
    description:
      "Get the logs for a workflow instance by its ID — the workflow-instance-scoped log. Related: get_workflow_association_instance_logs (the association-instance run log) and get_workflow_activity_log (a single activity's log). Read-only.",
  },

  // --- Cluster: audience block results (ONE block; plural is hand-owned). ---
  GetWorkflowsAudienceBlockInstanceResults: {
    toolName: "get_workflow_audience_block_instance_results",
    category: "workflows",
    description:
      "Get the results of ONE audience block instance (BlockInstanceID) within an audience-workflow activity (ActivityID + WorkflowAssociationInstanceID) — that single block's membership/counts. For ALL blocks of the activity use the get_audience_workflow_block_results hand tool (plural). Read-only.",
  },

  // ======================================================================
  // Domain: operations (#27634). CLIENT-scoped operational reads — the
  // client/tenant counterparts to the cluster-scoped reads (category "cluster")
  // and the admin hand tools. Every log/task read names its scope (client) and
  // cross-refs the cluster-wide equivalent so the two don't blur.
  // ======================================================================

  // --- Cluster: client operation logs + tasks (client-scoped; cross-ref the
  //     cluster-wide equivalents). Axis: WHICH log/what scope. ---
  GetOperationManagementAuditHistory: {
    toolName: "get_operation_audit_history",
    category: "operations",
    description:
      "Get the CLIENT's audit history (paged, PageNumber/PageSize) — the change/action audit trail scoped to this client/tenant. SQL-statement-level audit is get_operation_sql_audit_history; the CLUSTER-wide audit trail is the get_cluster_audit_history hand tool. Read-only.",
  },
  GetOperationManagementSqlAuditHistory: {
    toolName: "get_operation_sql_audit_history",
    category: "operations",
    description:
      "Get the CLIENT's SQL audit history (paged) — audited SQL statements executed for this client. The general (non-SQL) client audit trail is get_operation_audit_history. Read-only.",
  },
  GetOperationManagementHousekeepingLogs: {
    toolName: "get_operation_housekeeping_logs",
    category: "operations",
    description:
      "Get the CLIENT's housekeeping (maintenance-job) logs (paged) — cleanup/retention jobs scoped to this client. The CLUSTER-wide equivalent is get_cluster_housekeeping_log. Read-only.",
  },
  GetOperationManagementSystemTasks: {
    toolName: "list_operation_system_tasks",
    category: "operations",
    description:
      "List the CLIENT's system tasks — background/scheduled jobs scoped to this client and their state. The CLUSTER-wide equivalent is get_cluster_system_tasks. Read-only.",
  },

  // --- Cluster: other client-ops reads. ---
  GetOperationManagementExecutionServices: {
    toolName: "list_execution_services",
    category: "operations",
    description:
      "List the execution services available to the client — the compute/execution endpoints that run the client's workflows and jobs, with their status. No ID. Read-only.",
  },
  GetClientOperationManagementAudienceSnapshotWorkflowsStatus: {
    toolName: "get_audience_snapshot_workflows_status",
    category: "operations",
    description:
      "Get the status of the client's audience-snapshot workflows — whether snapshot refresh runs are pending/running/complete. About the snapshot RUNS; the snapshots themselves are get_audience_snapshot / list_audience_snapshots (configuration domain). Read-only.",
  },
  GetSystemHealthMonitoringOverview: {
    toolName: "get_system_health_monitoring_overview",
    category: "operations",
    description:
      "Get the client's system-health monitoring overview — an aggregate health/status view (pass RunCheckNow to force a fresh check; SkipIfNotAvailable to skip checks that are unavailable). Distinct from the get_system_health_availability hand tool (the cluster availability probe). Read-only.",
  },

  // ======================================================================
  // Domain: remainder (#27634) — the last small areas. Singletons fold into the
  // existing auth/configuration categories; coherent pairs/quads get their own
  // small categories (data-import, content-preview, jobs, smart-assets). This
  // clears the awaiting list to 0.
  // ======================================================================

  // --- auth (existing category): tenant login config + user recent items. ---
  GetLoginSettings: {
    toolName: "get_login_settings",
    category: "auth",
    description:
      "Get the tenant's login/authentication settings — the configured identity provider (e.g. OpenID/Keycloak) and login options. Use to see how sign-in is configured. Read-only.",
  },
  GetUserRecentItems: {
    toolName: "get_user_recent_items",
    category: "auth",
    description:
      "Get the authenticated user's recently-accessed items — the caller's recent files/objects (user-scoped convenience list). No ID. Read-only.",
  },

  // --- configuration (existing category): attribute values + SCV event details. ---
  GetAttributeValueList: {
    toolName: "get_attribute_value_list",
    category: "configuration",
    description:
      "Get the enumerated VALUES of an attribute value list by ID (pass ForceRefresh to bypass any cache) — the values themselves, not the list of lists. Distinct from get_attribute_list (a reusable set of attributes) and list_value_lists (the value-list definitions). Read-only.",
  },
  GetSingleCustomerViewEventDetailsAsHtml: {
    toolName: "get_single_customer_view_event_details_html",
    category: "configuration",
    description:
      "Get a single-customer-view event's details rendered as HTML — the detail card for one channel-execution event (ChannelExecutionID + OfferTemplateInstanceID + OfferCode). Relates to the single-customer-view definition reads (get_single_customer_view). Read-only.",
  },

  // --- Domain: data-import (new category). ---
  GetDataImportFile: {
    toolName: "get_data_import_file",
    category: "data-import",
    description:
      "Get one data-import file by ID — the definition/metadata of a data import. Its cleanup history: get_data_import_file_housekeeping_records. Distinct from the data-import file SYSTEM (get_data_import_file_system_configuration / list_data_import_file_system_files). Read-only.",
  },
  GetDataImportFileHousekeepingRecords: {
    toolName: "get_data_import_file_housekeeping_records",
    category: "data-import",
    description:
      "Get the housekeeping (cleanup/retention) records for a data-import file (ID). For the import file itself use get_data_import_file. Read-only.",
  },
  GetDataImportFileSystemConfiguration: {
    toolName: "get_data_import_file_system_configuration",
    category: "data-import",
    description:
      "Get the data-import file-SYSTEM configuration — how the client's import drop-locations/paths are set up. To list the files present use list_data_import_file_system_files; for a specific import file use get_data_import_file. Read-only.",
  },
  GetDataImportFileSystemFiles: {
    toolName: "list_data_import_file_system_files",
    category: "data-import",
    description:
      "List the files present in the data-import file system — optionally filtered by ExtensionFilter and recursing subdirectories (IncludeSubDirectories). The FS configuration is get_data_import_file_system_configuration. Read-only.",
  },

  // --- Domain: content-preview (new category). ---
  GetContentCombinations: {
    toolName: "get_content_combinations",
    category: "content-preview",
    description:
      "Get the available content combinations for a file/content/template (FileID + ContentID + TemplateID) — the variants that can be previewed. Render one as HTML with get_content_preview_html. Read-only.",
  },
  GetContentPreviewHtml: {
    toolName: "get_content_preview_html",
    category: "content-preview",
    description:
      "Render a content preview as HTML — the resolved content for a file/content/template (FileID + ContentID + TemplateID; optional DynamicContentInstanceHashID for a specific dynamic-content instance). For the available variants first use get_content_combinations. Read-only.",
  },

  // --- Domain: jobs (new category). Async job status vs log, by job ID. ---
  GetJobStatusById: {
    toolName: "get_job_status",
    category: "jobs",
    description:
      "Get the status of a job by its ID — current state/progress of an async job (paged via PageNumber). For the job's log output use get_job_log. Read-only.",
  },
  GetJobLogById: {
    toolName: "get_job_log",
    category: "jobs",
    description:
      "Get the log output of a job by its ID (paged via PageNumber) — the run messages. For the job's status/progress use get_job_status. Read-only.",
  },

  // --- Domain: smart-assets (new category). Asset vs its JS embed snippet. ---
  GetSmartAsset: {
    toolName: "get_smart_asset",
    category: "smart-assets",
    description:
      "Get one smart asset by ID — a smart (dynamic/personalized) content asset. Its embeddable JavaScript is get_smart_asset_javascript_snippet. Read-only.",
  },
  GetSmartAssetJavaScriptSnippet: {
    toolName: "get_smart_asset_javascript_snippet",
    category: "smart-assets",
    description:
      "Get the JavaScript embed snippet for a smart asset (ID) — the code to place the asset on a page. For the asset itself use get_smart_asset. Read-only.",
  },
};

// NOTE: the set of endpoints already served by the hand-written 47 (the additive
// skip-set) is DERIVED at generation time from the actual hand tools' _meta.endpoints
// (see deriveHandEndpoints in scripts/generate-tools.ts) — never a hand-list here,
// so it can't drift from the real hand-tool surface.
