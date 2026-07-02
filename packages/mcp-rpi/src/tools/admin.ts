import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import { createToolRegistrar } from "../tool-categories.js";

const verboseSchema = z
  .boolean()
  .default(false)
  .describe(
    "Return the full unfiltered RPI response. Default false strips verbose metadata ($jsonType, $jsonTypeID, data, fileInfo) to save tokens.",
  );

export function registerAdminTools(
  server: McpServer,
  rpiClient: RPIApiClient,
) {
  const registerTool = createToolRegistrar(server, "admin");

  registerTool(
    "get_system_health_availability",
    {
      title: "Get Cluster System Health Availability",
      description:
        "Get cluster-wide system health availability status.",
      inputSchema: { verbose: verboseSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/cluster/operations/system-health/availability",
          undefined,
          { verbose },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error getting system health availability: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "get_cluster_api_error_log",
    {
      title: "Get Cluster API Error Log",
      description:
        "Get a paginated log of cluster-wide API errors. Supports filtering by title substring and RPI client ID. Useful for troubleshooting integration issues.",
      inputSchema: {
        pageNumber: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("1-based page number"),
        pageSize: z
          .number()
          .int()
          .min(5)
          .max(255)
          .default(20)
          .describe("Results per page (5-255)"),
        titleContains: z
          .string()
          .optional()
          .describe("Substring filter applied to the error title"),
        filterClientId: z
          .string()
          .optional()
          .describe("Filter errors to those scoped to this RPI client/tenant ID (passed as the `clientID` query param to RPI; distinct from the universal `clientId` X-ClientID header override)"),
        verbose: verboseSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pageNumber, pageSize, titleContains, filterClientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const params: Record<string, string> = {
          pageNumber: String(pageNumber),
          pageSize: String(pageSize),
        };
        if (titleContains) params.titleContains = titleContains;
        if (filterClientId) params.clientID = filterClientId;
        const result = await rpiClient.get(
          userToken,
          "/cluster/operations/logs/error/api",
          params,
          { verbose },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error getting cluster API error log: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "get_cluster_audit_history",
    {
      title: "Get Cluster Audit History",
      description:
        "Get a paginated log of cluster-wide audit events. Each entry records who performed which action on which resource at what time.",
      inputSchema: {
        pageNumber: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("1-based page number"),
        pageSize: z
          .number()
          .int()
          .min(5)
          .max(255)
          .default(20)
          .describe("Results per page (5-255)"),
        verbose: verboseSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pageNumber, pageSize, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const params: Record<string, string> = {
          pageNumber: String(pageNumber),
          pageSize: String(pageSize),
        };
        const result = await rpiClient.get(
          userToken,
          "/cluster/operations/logs/audit-history",
          params,
          { verbose },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error getting cluster audit history: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
