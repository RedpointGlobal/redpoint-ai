import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DRHApiClient } from "../client/drh-api.js";
import {
  drhClientIdSchema,
  numericIdSchema,
  databaseIdArg,
  resolveDatabaseId,
  jsonContent,
  errorContent,
  READ_ONLY,
} from "./_shared.js";

/**
 * DRH UI/dashboard tools (13). UI REST API — database-scoped composite reads
 * under /api-op/v1/databases/{id}/…, preferred over the flat REST reads for
 * dashboard views (richer summaries, paging, sorting). All read-only. The
 * `databaseId` defaults to the tenant's database (resolved server-side) when
 * omitted. Named `*_database_*` so they never collide with the flat A–C reads.
 */
const pageNumber = z.number().int().optional().describe("Page number (1-based).");
const pageSize = z.number().int().optional().describe("Page size.");
const sortField = z.string().optional().describe("Field to sort by.");
const sortDirection = z.string().optional().describe("Sort direction (asc|desc).");

export function registerUiDashboardTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;
  const get = (
    path: string,
    query: Record<string, string | number | boolean | undefined | null>,
    clientId: string | undefined,
    extra: { authInfo?: { token?: string } },
  ) => client.request("GET", path, { query, clientId, userToken: token(extra) });

  server.registerTool(
    "drh_list_database_activities",
    {
      title: "List Database Activities",
      description: "List activities for a database. GET /databases/{id}/activities.",
      inputSchema: {
        databaseId: databaseIdArg,
        objectType: z.string().optional().describe("Filter by object type."),
        excludeObjectType: z.array(z.string()).optional().describe("Object types to exclude."),
        pageNumber,
        pageSize,
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, objectType, excludeObjectType, pageNumber, pageSize, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await get(
            `/api-op/v1/databases/${dbId}/activities`,
            { objectType, excludeObjectType: excludeObjectType?.join(","), pageNumber, pageSize },
            clientId,
            extra,
          ),
        );
      } catch (e) {
        return errorContent("Error listing database activities", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_cdp_summary",
    {
      title: "Get Database CDP Summary",
      description: "Get the CDP summary for a database. GET /databases/{id}/cdp/summary.",
      inputSchema: { databaseId: databaseIdArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(await get(`/api-op/v1/databases/${dbId}/cdp/summary`, {}, clientId, extra));
      } catch (e) {
        return errorContent("Error getting CDP summary", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_summary",
    {
      title: "Get Database Summary",
      description: "Get a database summary. GET /databases/{id}/summary.",
      inputSchema: { databaseId: databaseIdArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(await get(`/api-op/v1/databases/${dbId}/summary`, {}, clientId, extra));
      } catch (e) {
        return errorContent("Error getting database summary", e);
      }
    },
  );

  server.registerTool(
    "drh_list_database_feeds",
    {
      title: "List Database Feeds",
      description: "List feeds for a database. GET /databases/{id}/feeds.",
      inputSchema: {
        databaseId: databaseIdArg,
        sourceId: z.number().int().optional().describe("Filter by source id."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, sourceId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(await get(`/api-op/v1/databases/${dbId}/feeds`, { sourceId }, clientId, extra));
      } catch (e) {
        return errorContent("Error listing database feeds", e);
      }
    },
  );

  server.registerTool(
    "drh_list_database_feeds_page",
    {
      title: "List Database Feeds (Paged)",
      description: "Get a paged, sortable, filterable list of feeds for a database. GET /databases/{id}/feeds-page.",
      inputSchema: {
        databaseId: databaseIdArg,
        pageNumber,
        pageSize,
        sourceId: z.number().int().optional().describe("Filter by source id."),
        feedName: z.string().optional().describe("Filter by feed name."),
        feedStatus: z.string().optional().describe("Filter by feed status."),
        feedState: z.string().optional().describe("Filter by feed state."),
        sortField,
        sortDirection,
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId, ...q }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(await get(`/api-op/v1/databases/${dbId}/feeds-page`, q, clientId, extra));
      } catch (e) {
        return errorContent("Error listing database feeds (paged)", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_feeds_summary",
    {
      title: "Get Database Feeds Summary",
      description: "Get the feeds collection summary for a database. GET /databases/{id}/feeds/summary.",
      inputSchema: {
        databaseId: databaseIdArg,
        sourceId: z.number().int().optional().describe("Filter by source id."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, sourceId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await get(`/api-op/v1/databases/${dbId}/feeds/summary`, { "source-id": sourceId }, clientId, extra),
        );
      } catch (e) {
        return errorContent("Error getting database feeds summary", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_feed",
    {
      title: "Get Database Feed",
      description: "Get the latest version of a feed in a database. GET /databases/{id}/feeds/{feedId}.",
      inputSchema: {
        databaseId: databaseIdArg,
        feedId: numericIdSchema("Feed id (numeric)."),
        feedRunId: z.number().int().optional().describe("Scope to a specific feed run."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, feedId, feedRunId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await get(`/api-op/v1/databases/${dbId}/feeds/${feedId}`, { feedRunId }, clientId, extra),
        );
      } catch (e) {
        return errorContent("Error getting database feed", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_feed_version",
    {
      title: "Get Database Feed Version",
      description: "Get a specific version of a feed in a database. GET /databases/{id}/feeds/{feedId}/{version}.",
      inputSchema: {
        databaseId: databaseIdArg,
        feedId: numericIdSchema("Feed id (numeric)."),
        versionNumber: numericIdSchema("Version number."),
        feedRunId: z.number().int().optional().describe("Scope to a specific feed run."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, feedId, versionNumber, feedRunId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await get(
            `/api-op/v1/databases/${dbId}/feeds/${feedId}/${versionNumber}`,
            { feedRunId },
            clientId,
            extra,
          ),
        );
      } catch (e) {
        return errorContent("Error getting database feed version", e);
      }
    },
  );

  server.registerTool(
    "drh_list_database_match_runs",
    {
      title: "List Database Match Runs",
      description: "List the latest match-run summaries for a database. GET /databases/{id}/match-runs.",
      inputSchema: {
        databaseId: databaseIdArg,
        pageNumber,
        pageSize,
        feedId: z.number().int().optional().describe("Filter by feed id."),
        feedName: z.string().optional().describe("Filter by feed name."),
        sortField,
        sortDirection,
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId, ...q }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(await get(`/api-op/v1/databases/${dbId}/match-runs`, q, clientId, extra));
      } catch (e) {
        return errorContent("Error listing database match runs", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_consolidation_rate",
    {
      title: "Get Database Consolidation Rate",
      description: "Get the average consolidation-rate metric for a database. GET /databases/{id}/match-runs/consolidation-rate.",
      inputSchema: {
        databaseId: databaseIdArg,
        feedId: z.number().int().optional().describe("Filter by feed id."),
        feedRunId: z.number().int().optional().describe("Scope to a specific feed run."),
        count: z.number().int().optional().describe("Number of data points."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId, ...q }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await get(`/api-op/v1/databases/${dbId}/match-runs/consolidation-rate`, q, clientId, extra),
        );
      } catch (e) {
        return errorContent("Error getting consolidation rate", e);
      }
    },
  );

  server.registerTool(
    "drh_list_database_rpi_sync_runs",
    {
      title: "List Database RPI Sync Runs",
      description: "List the latest RPI sync-run summaries for a database. GET /databases/{id}/rpi-sync-runs.",
      inputSchema: {
        databaseId: databaseIdArg,
        pageNumber,
        pageSize,
        sortField,
        sortDirection,
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId, ...q }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(await get(`/api-op/v1/databases/${dbId}/rpi-sync-runs`, q, clientId, extra));
      } catch (e) {
        return errorContent("Error listing database RPI sync runs", e);
      }
    },
  );

  server.registerTool(
    "drh_list_database_sources",
    {
      title: "List Database Sources",
      description: "List sources for a database. GET /databases/{id}/sources.",
      inputSchema: {
        databaseId: databaseIdArg,
        pageNumber,
        pageSize,
        enabled: z.boolean().optional().describe("Filter by enabled state."),
        name: z.string().optional().describe("Filter by source name."),
        status: z.string().optional().describe("Filter by status."),
        sortField,
        sortDirection,
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId, ...q }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(await get(`/api-op/v1/databases/${dbId}/sources`, q, clientId, extra));
      } catch (e) {
        return errorContent("Error listing database sources", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_source",
    {
      title: "Get Database Source",
      description: "Get a source for a database. GET /databases/{id}/sources/{sourceId}.",
      inputSchema: {
        databaseId: databaseIdArg,
        sourceId: numericIdSchema("Source id (numeric)."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, sourceId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await get(`/api-op/v1/databases/${dbId}/sources/${sourceId}`, {}, clientId, extra),
        );
      } catch (e) {
        return errorContent("Error getting database source", e);
      }
    },
  );
}
