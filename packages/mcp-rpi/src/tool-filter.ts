/**
 * Server-side `tools/list` filter that honors `category` and `names` params.
 *
 * The MCP SDK's built-in `ListToolsRequestSchema` strips unknown params, so
 * we register a permissive replacement schema that accepts the filter fields.
 * The new handler delegates to the SDK's original handler to build the full
 * tool list (preserving schema normalization), then filters the result.
 *
 * This mirrors the Java RPI-MCPServer's `tools/list` extension so external
 * clients (Claude Desktop, Cursor, direct SDK) can narrow the catalog.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_CATEGORIES, type ToolCategory } from "./tool-categories.js";

const TOOLS_LIST_METHOD = "tools/list";

/**
 * Human-readable descriptions advertised in the `availableCategories` capability.
 * Kept here (rather than alongside TOOL_CATEGORIES) to keep the category type
 * narrow — the type is a string-literal union used in tool-registration code,
 * while these descriptions are consumed by the MCP client's category-discovery
 * UX and are an independent concern.
 */
const CATEGORY_DESCRIPTIONS: Record<ToolCategory, string> = {
  audiences:
    "Audience files and audience definitions (data structure templates)",
  admin:
    "Cluster operations (system health availability, API error log, audit history)",
  auth:
    "Authentication & user context — connection/token diagnostics, login/OIDC settings, and the caller's profile / accessible clients / recent items",
  clients: "RPI client (tenant) discovery",
  "file-system":
    "File metadata & relationships (type-agnostic) — resolve a GUID to its name/type/folder card, plus a file's metadata, history, and forward/reverse dependencies, and external-storage connector search. NOT the file's content (files category) or the folder tree (folders)",
  folders:
    "The folder/path tree that contains files — browse the tree, get a folder by id or full path, list a folder's contents, read folder permissions, or the user's private folder, and create folders. NOT the files themselves (files/file-system)",
  interactions:
    "Interactions and their sub-resources (activity, trigger, available inputs, metadata, workflows, next firing times)",
  "selection-rules":
    "Selection rules — Basic (document-database-decision) and Standard subtypes, plus document definitions available to Basic rules",
  configuration:
    "Client configuration reads — attribute lists, audience/selection metadata, and other tenant configuration resources",
  files:
    "Content-file objects stored in the RPI file system — decision rules, analysis panels, digital content assets, offers, dashboards/widgets, cell lists, export templates, model projects (NOT file-system, which is folders/metadata)",
  cluster:
    "Cluster-level administration reads — cluster users and external (federated) users, installed plugins, per-client auxiliary databases, and cluster error/housekeeping logs and system tasks (spans all clients; complements the admin category)",
  "data-connectors":
    "Data-connector reads — sync definitions and live sync status/info (the connector activate/deactivate actions are intentionally not exposed on this read-only surface)",
  workflows:
    "Workflow-run execution telemetry — per-activity results/logs/assets/SQL-trace and instance-level logs/summaries for a workflow-association instance (the runtime diagnostics of a workflow run). Complements the interaction/audience hand tools that report workflow status/summary",
  operations:
    "Client-scoped operational reads — the client's audit / SQL-audit / housekeeping logs, system tasks, execution services, audience-snapshot workflow status, and a system-health monitoring overview. Client-scoped counterparts to the cluster category and the admin hand tools",
  "data-import":
    "Data-import reads — import file definitions + housekeeping records, and the data-import file-system configuration + file listing",
  "content-preview":
    "Content preview reads — the available content combinations for a file/content/template, and rendering a combination as HTML",
  jobs:
    "Async job reads — a job's status/progress and its log output, by job ID",
  "smart-assets":
    "Smart-asset reads — a smart (dynamic/personalized) content asset and its embeddable JavaScript snippet",
};

export const FilteredListToolsRequestSchema = z.object({
  method: z.literal(TOOLS_LIST_METHOD),
  params: z
    .object({
      cursor: z.string().optional(),
      category: z.union([z.string(), z.array(z.string())]).optional(),
      names: z.array(z.string()).optional(),
      _meta: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
});

interface ToolDefinition {
  name: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ListToolsResult {
  tools: ToolDefinition[];
  [key: string]: unknown;
}

/**
 * Normalize a category param into a Set of trimmed category strings.
 * Accepts "a,b,c", ["a","b"], or undefined.
 */
function parseCategoryParam(
  category: string | string[] | undefined,
): Set<string> | null {
  if (!category) return null;
  const list = Array.isArray(category) ? category : category.split(",");
  const set = new Set(list.map((c) => c.trim()).filter(Boolean));
  return set.size > 0 ? set : null;
}

export function applyToolFilter(
  tools: ToolDefinition[],
  params: { category?: string | string[]; names?: string[] } | undefined,
): ToolDefinition[] {
  if (!params) return tools;
  const categoryFilter = parseCategoryParam(params.category);
  const nameFilter = params.names && params.names.length > 0
    ? new Set(params.names)
    : null;

  if (!categoryFilter && !nameFilter) return tools;

  return tools.filter((tool) => {
    if (nameFilter && !nameFilter.has(tool.name)) return false;
    if (categoryFilter) {
      const cat = tool._meta?.category;
      if (typeof cat !== "string" || !categoryFilter.has(cat)) return false;
    }
    return true;
  });
}

/**
 * Install a filtered `tools/list` handler on the server. Must be called after
 * all tools have been registered (so the SDK's default handler exists and can
 * be delegated to for building the full tool list).
 */
export function installToolFilter(server: McpServer): void {
  // Capture the SDK's original tools/list handler before we replace it.
  // The handler lives in the low-level Server's private _requestHandlers map.
  const lowLevelServer = server.server as unknown as {
    _requestHandlers: Map<
      string,
      (req: unknown, extra: unknown) => Promise<unknown>
    >;
  };
  const originalHandler = lowLevelServer._requestHandlers.get(TOOLS_LIST_METHOD);
  if (!originalHandler) {
    throw new Error(
      "installToolFilter: no existing tools/list handler found. Register tools before calling this.",
    );
  }

  server.server.setRequestHandler(
    FilteredListToolsRequestSchema,
    async (request, extra) => {
      // Delegate to the SDK's original handler with a bare request to get the
      // full list with proper schema normalization, then filter.
      const full = (await originalHandler(
        { method: TOOLS_LIST_METHOD, params: {} },
        extra,
      )) as ListToolsResult;

      return {
        ...full,
        tools: applyToolFilter(full.tools as ToolDefinition[], request.params),
      };
    },
  );

  // Count enabled tools per category from the SDK's private registry so we
  // can report accurate `estimatedToolCount` values in the capabilities
  // descriptor. Read-only access; private API but stable in SDK 1.29.x.
  const registered = (server as unknown as {
    _registeredTools: Record<
      string,
      { enabled: boolean; _meta?: Record<string, unknown> }
    >;
  })._registeredTools;
  const countsByCategory = new Map<string, number>();
  for (const tool of Object.values(registered)) {
    if (!tool.enabled) continue;
    const cat = tool._meta?.category;
    if (typeof cat !== "string") continue;
    countsByCategory.set(cat, (countsByCategory.get(cat) ?? 0) + 1);
  }

  const availableCategories = TOOL_CATEGORIES.map((name) => ({
    name,
    description: CATEGORY_DESCRIPTIONS[name] ?? "",
    estimatedToolCount: countsByCategory.get(name) ?? 0,
  }));

  // Advertise filtering capability so clients can discover it via `initialize`.
  // Shape matches the Java RPI-MCPServer's contract so v3-compatible clients
  // that extract `tools.listTools.{supportsFiltering, availableCategories,
  // filterParameter}` can activate category-discovery mode.
  server.server.registerCapabilities({
    tools: {
      listChanged: true,
      listTools: {
        supportsFiltering: true,
        availableCategories,
        filterParameter: {
          name: "category",
          description:
            "Filter tools to only those matching one or more categories. Accepts a comma-separated string or an array of category names.",
          examples: [
            "audiences",
            "audiences,interactions",
            ["selection-rules", "clients"],
          ],
        },
      },
    } as unknown as Record<string, unknown>,
  });
}
