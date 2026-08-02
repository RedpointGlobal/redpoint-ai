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
  MUTATING,
  DESTRUCTIVE,
} from "./_shared.js";

/**
 * DRH data-quality tools (7). Data Qualities REST API under
 * /api-op/v1/data-qualities. Most reads are database-scoped via a `databaseId`
 * query param (defaults to the tenant's database when omitted); the
 * hygiene/confidence/processed-matches reads take an optional `count`. Numeric
 * dataQualityId path.
 */
const countArg = z
  .number()
  .int()
  .optional()
  .describe("Max number of records to return.");

export function registerDataQualityTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_get_data_quality",
    {
      title: "Get Data Quality",
      description: "Get the latest data quality for a database. GET /data-qualities?databaseId=.",
      inputSchema: { databaseId: databaseIdArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await client.request("GET", "/api-op/v1/data-qualities", {
            query: { databaseId: dbId },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting data quality", e);
      }
    },
  );

  server.registerTool(
    "drh_get_data_quality_by_id",
    {
      title: "Get Data Quality by ID",
      description: "Fetch one data quality by id. GET /data-qualities/{id}.",
      inputSchema: { dataQualityId: numericIdSchema("Data quality id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ dataQualityId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/data-qualities/${dataQualityId}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting data quality", e);
      }
    },
  );

  server.registerTool(
    "drh_create_data_quality",
    {
      title: "Create Data Quality",
      description: "Create a data quality. POST /data-qualities.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Data-quality payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/data-qualities", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error creating data quality", e);
      }
    },
  );

  server.registerTool(
    "drh_delete_data_quality",
    {
      title: "Delete Data Quality",
      description: "Delete the data quality for a database. DELETE /data-qualities?databaseId=.",
      inputSchema: { databaseId: databaseIdArg, clientId: drhClientIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await client.request("DELETE", "/api-op/v1/data-qualities", {
            query: { databaseId: dbId },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error deleting data quality", e);
      }
    },
  );

  server.registerTool(
    "drh_get_hygiene_scores",
    {
      title: "Get Hygiene Scores",
      description: "List the latest hygiene scores for a database. GET /data-qualities/hygiene-scores?databaseId=&count=.",
      inputSchema: { databaseId: databaseIdArg, count: countArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ databaseId, count, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await client.request("GET", "/api-op/v1/data-qualities/hygiene-scores", {
            query: { databaseId: dbId, count },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting hygiene scores", e);
      }
    },
  );

  server.registerTool(
    "drh_get_match_confidence",
    {
      title: "Get Match Confidence",
      description: "List the latest match-confidence counts for a database. GET /data-qualities/match-confidence?databaseId=&count=.",
      inputSchema: { databaseId: databaseIdArg, count: countArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ databaseId, count, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await client.request("GET", "/api-op/v1/data-qualities/match-confidence", {
            query: { databaseId: dbId, count },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting match confidence", e);
      }
    },
  );

  server.registerTool(
    "drh_get_processed_matches",
    {
      title: "Get Processed Matches",
      description: "List the latest processed matches for a database. GET /data-qualities/processed-matches?databaseId=&count=.",
      inputSchema: { databaseId: databaseIdArg, count: countArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ databaseId, count, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await client.request("GET", "/api-op/v1/data-qualities/processed-matches", {
            query: { databaseId: dbId, count },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting processed matches", e);
      }
    },
  );
}
