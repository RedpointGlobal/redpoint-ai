/**
 * Unit tests for server-side `tools/list` filtering.
 * Covers the pure filter function and a full round-trip via the real MCP
 * server (registers all tool domains, queries tools/list with various params).
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { applyToolFilter } from "../tool-filter.js";
import { createRPIMcpServer } from "../server.js";
import type { RPIConfig } from "../config.js";
import { RPIAuthService } from "../client/rpi-auth.js";

// ---------------------------------------------------------------------------
// applyToolFilter (pure function) — every permutation
// ---------------------------------------------------------------------------

const sample = [
  { name: "list_audiences", _meta: { category: "audiences" } },
  { name: "create_audience", _meta: { category: "audiences" } },
  { name: "list_workflows", _meta: { category: "campaigns" } },
  { name: "get_decision", _meta: { category: "realtime" } },
  { name: "verify_connection", _meta: { category: "auth" } },
];

describe("applyToolFilter", () => {
  it("returns all tools when no params", () => {
    expect(applyToolFilter(sample, undefined).length).toBe(5);
    expect(applyToolFilter(sample, {}).length).toBe(5);
  });

  it("filters by single category string", () => {
    const result = applyToolFilter(sample, { category: "audiences" });
    expect(result.map((t) => t.name)).toEqual([
      "list_audiences",
      "create_audience",
    ]);
  });

  it("filters by comma-separated category string", () => {
    const result = applyToolFilter(sample, {
      category: "audiences,realtime",
    });
    expect(result.map((t) => t.name).sort()).toEqual([
      "create_audience",
      "get_decision",
      "list_audiences",
    ]);
  });

  it("filters by category array", () => {
    const result = applyToolFilter(sample, {
      category: ["campaigns", "auth"],
    });
    expect(result.map((t) => t.name).sort()).toEqual([
      "list_workflows",
      "verify_connection",
    ]);
  });

  it("filters by names array", () => {
    const result = applyToolFilter(sample, {
      names: ["get_decision", "verify_connection"],
    });
    expect(result.map((t) => t.name).sort()).toEqual([
      "get_decision",
      "verify_connection",
    ]);
  });

  it("applies intersection when category and names both present", () => {
    const result = applyToolFilter(sample, {
      category: "audiences",
      names: ["list_audiences", "get_decision"],
    });
    // get_decision fails category filter; list_audiences passes both
    expect(result.map((t) => t.name)).toEqual(["list_audiences"]);
  });

  it("returns empty for unknown category", () => {
    const result = applyToolFilter(sample, { category: "nonexistent" });
    expect(result).toEqual([]);
  });

  it("returns empty for unknown names", () => {
    const result = applyToolFilter(sample, { names: ["does_not_exist"] });
    expect(result).toEqual([]);
  });

  it("excludes tools without a category when category filter is present", () => {
    const withMissing = [...sample, { name: "mystery_tool", _meta: {} }];
    const result = applyToolFilter(withMissing, { category: "audiences" });
    expect(result.map((t) => t.name).includes("mystery_tool")).toBe(false);
  });

  it("handles whitespace in comma-separated categories", () => {
    const result = applyToolFilter(sample, {
      category: "  audiences , realtime  ",
    });
    expect(result.map((t) => t.name).sort()).toEqual([
      "create_audience",
      "get_decision",
      "list_audiences",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Full server round-trip — verifies the SDK override works end-to-end
// ---------------------------------------------------------------------------

describe("tools/list filtering via live server", () => {
  let server: ReturnType<typeof createRPIMcpServer>["server"];

  beforeAll(() => {
    const config: RPIConfig = {
      integrationApiUrl: "https://example.com",
      proxyEnabled: false,
      oauthClientId: "test-oauth-client",
      oauthClientSecret: "test-oauth-secret",
      defaultClientId: "test-default-client",
      authRequired: false,
    };
    const authService = new RPIAuthService(
      config.integrationApiUrl,
      config.oauthClientId,
      config.oauthClientSecret,
    );
    ({ server } = createRPIMcpServer(config, authService));
  });

  async function callToolsList(
    params: Record<string, unknown> = {},
  ): Promise<{ tools: Array<{ name: string; _meta?: Record<string, unknown> }> }> {
    const handlers = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (req: unknown, extra: unknown) => Promise<{
            tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
          }>
        >;
      }
    )._requestHandlers;
    const handler = handlers.get("tools/list");
    if (!handler) throw new Error("tools/list handler not registered");
    return handler(
      { method: "tools/list", params },
      { signal: new AbortController().signal, sendRequest: () => Promise.resolve({}) },
    );
  }

  // 46 hand tools + 153 generated (#27634 complete: 185 in-scope GETs = 153
  // authored + 29 hand-covered + 3 suppressed functional-dups) = 199 registered
  // (list_interaction_runs removed, #27897 — its endpoint was unusable);
  // 5 hand writes are gated at construction, so tools/list — which the SDK filters
  // on `enabled` — exposes 197 (44 hand reads + 153 generated). The mask is a no-op
  // here (harness passes no instanceEndpoints). Explicit gate checks live in
  // write-enforcement.test.ts.
  it("returns 197 enabled tools with no filter (5 write tools gated; +153 generated)", async () => {
    const result = await callToolsList();
    expect(result.tools.length).toBe(197);
  });

  it("returns 7 file-system tools when category=file-system (1 hand + 6 generated)", async () => {
    const result = await callToolsList({ category: "file-system" });
    expect(result.tools.length).toBe(7);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_file_dependencies",
      "get_file_dependents",
      "get_file_history",
      "get_file_info_by_id",
      "get_file_metadata",
      "list_file_info_attribute_lists",
      "search_external_folder_connectors",
    ]);
  });

  it("returns 6 folder tools when category=folders (create_folder gated; 1 hand + 5 generated)", async () => {
    const result = await callToolsList({ category: "folders" });
    expect(result.tools.length).toBe(6);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_folder_by_full_path",
      "get_folder_permissions",
      "get_folder_permissions_by_full_path",
      "get_user_private_folder",
      "list_folder_content",
      "list_folders",
    ]);
  });

  it("returns 8 selection rule tools when category=selection-rules", async () => {
    const result = await callToolsList({ category: "selection-rules" });
    expect(result.tools.length).toBe(8);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_basic_selection_rule_by_id",
      "get_selection_rule_by_name",
      "get_selection_rule_sql_count_query",
      "get_standard_selection_rule_by_id",
      "list_basic_selection_rule_document_definitions",
      "list_selection_rules",
      "run_selection_rule_count",
      "run_selection_rule_waterfall",
    ]);
  });

  it("returns 14 interaction tools when category=interactions (3 writes gated)", async () => {
    const result = await callToolsList({ category: "interactions" });
    expect(result.tools.length).toBe(15);
    const names = result.tools.map((t) => t.name).sort();
    // activate_interaction_workflow, control_workflow_instance, and
    // run_interaction_workflow are gated writes — absent here.
    expect(names).toEqual([
      "calculate_interaction_next_firing_times",
      "get_interaction_activity",
      "get_interaction_available_inputs",
      "get_interaction_by_id",
      "get_interaction_by_name",
      "get_interaction_default_metadata",
      "get_interaction_run_counts",
      "get_interaction_trigger",
      "get_interaction_workflow_activities",
      "get_interaction_workflow_instances",
      "get_interaction_workflows",
      "get_interactions_workflow_status",
      "get_workflow_instance_summary",
      "list_interactions",
      "summarize_interaction_runs",
    ]);
  });

  it("returns 3 client tools when category=clients", async () => {
    const result = await callToolsList({ category: "clients" });
    expect(result.tools.length).toBe(3);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_client_by_id",
      "get_client_by_name",
      "list_clients",
    ]);
  });

  it("returns only audience tools when category=audiences (run_audience_test_workflow gated)", async () => {
    const result = await callToolsList({ category: "audiences" });
    expect(result.tools.length).toBe(12);
    for (const t of result.tools) {
      expect(t._meta?.category).toBe("audiences");
    }
  });

  it("returns 3 admin tools when category=admin (ops-management)", async () => {
    const result = await callToolsList({ category: "admin" });
    expect(result.tools.length).toBe(3);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_cluster_api_error_log",
      "get_cluster_audit_history",
      "get_system_health_availability",
    ]);
  });

  it("returns intersection when both category and names are set", async () => {
    const result = await callToolsList({
      category: "audiences",
      names: ["list_audiences", "get_decision"],
    });
    expect(result.tools.map((t) => t.name)).toEqual(["list_audiences"]);
  });

  it("each registered tool has a _meta.category stamped", async () => {
    const result = await callToolsList();
    for (const t of result.tools) {
      expect(typeof t._meta?.category).toBe("string");
    }
  });

  // -------------------------------------------------------------------------
  // LOAD-BEARING TOOL-PRESENCE GUARD (#27957 regen fallout).
  // get_user_client_list was silently DROPPED when the 7.8 regen's
  // deriveHandEndpoints treated verify_connection's _meta.endpoints probe of
  // /authentication/user-client-list as hand-coverage and suppressed the overlay
  // tool. Nothing pinned it, so the drop was invisible until a live flow broke.
  // These guards make any future _meta/overlay change that removes a tool the
  // skills/routing layer depends on FAIL HERE, not in production. Add to
  // LOAD_BEARING when a skill's mcpToolFilter or a routing path starts depending
  // on a tool whose loss would be silent.
  // -------------------------------------------------------------------------
  const LOAD_BEARING = [
    // foundation-expert tenant steering (#27828) lists accessible tenants with
    // this; rpi-admin exposes it. THE tool the regen dropped.
    "get_user_client_list",
    "verify_connection", // THE connection/auth check
    "list_clients", // core client list (rpi-clients)
    "list_interactions", // rpi-interactions core
    "summarize_interaction_runs", // run summary (#27897)
    "get_interaction_run_counts", // run-counts over time (#27957)
    "list_audiences", // rpi-audiences core
  ];

  it("exposes every load-bearing tool the skills/routing layer depends on", async () => {
    const present = new Set((await callToolsList()).tools.map((t) => t.name));
    const missing = LOAD_BEARING.filter((n) => !present.has(n));
    expect(missing).toEqual([]);
  });

  it("get_user_client_list is present (regen-drop regression, #27957)", async () => {
    const present = new Set((await callToolsList()).tools.map((t) => t.name));
    expect(present.has("get_user_client_list")).toBe(true);
  });

  it("advertises Java-compatible category discovery capabilities on the server", () => {
    // The McpServer stashes registered capabilities on the low-level Server
    // instance as `_capabilities`. The v3 and RP_AI extractors both read
    // `tools.listTools.{supportsFiltering, availableCategories, filterParameter}`.
    const caps = (
      server.server as unknown as {
        _capabilities?: { tools?: Record<string, unknown> };
      }
    )._capabilities;
    expect(caps?.tools).toBeDefined();

    const listTools = (caps!.tools as { listTools?: Record<string, unknown> })
      .listTools;
    expect(listTools).toBeDefined();
    expect(listTools!.supportsFiltering).toBe(true);

    const categories = listTools!.availableCategories as Array<{
      name: string;
      description: string;
      estimatedToolCount: number;
    }>;
    expect(Array.isArray(categories)).toBe(true);
    // 8 hand categories + 10 #27634 generated-tool categories (configuration,
    // files, cluster, data-connectors, workflows, operations, data-import,
    // content-preview, jobs, smart-assets) = 18.
    expect(categories.length).toBe(18);

    const fileSystem = categories.find((c) => c.name === "file-system");
    expect(fileSystem!.estimatedToolCount).toBe(7);

    // estimatedToolCount reflects ENABLED tools — the gate runs before
    // installToolFilter counts them, so gated writes are excluded.
    const audiences = categories.find((c) => c.name === "audiences");
    expect(audiences).toBeDefined();
    expect(audiences!.estimatedToolCount).toBe(12); // 13 registered − 1 gated write
    expect(audiences!.description.length).toBeGreaterThan(0);

    const admin = categories.find((c) => c.name === "admin");
    expect(admin!.estimatedToolCount).toBe(3);

    const interactions = categories.find((c) => c.name === "interactions");
    expect(interactions!.estimatedToolCount).toBe(15); // 18 registered − 3 gated writes

    const filterParameter = listTools!.filterParameter as {
      name: string;
      description: string;
      examples: unknown[];
    };
    expect(filterParameter.name).toBe("category");
    expect(filterParameter.description.length).toBeGreaterThan(0);
    expect(Array.isArray(filterParameter.examples)).toBe(true);
    expect(filterParameter.examples.length).toBeGreaterThan(0);
  });
});
