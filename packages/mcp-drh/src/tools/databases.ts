import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DRHApiClient } from "../client/drh-api.js";
import {
  drhClientIdSchema,
  numericIdSchema,
  jsonContent,
  errorContent,
  READ_ONLY,
  MUTATING,
  DESTRUCTIVE,
} from "./_shared.js";

/**
 * DRH database tools (10). Endpoints under /api-op/v1/databases. Numeric
 * databaseId. Create/update/patch bodies are passed through to the API (the
 * caller supplies the OpenAPI Database payload); reads/deletes are typed.
 */
const dbBody = z
  .record(z.unknown())
  .describe("Database payload (the OpenAPI Database object).");

export function registerDatabaseTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_list_databases",
    {
      title: "List Databases",
      description: "List all Data Readiness Hub databases. GET /databases.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/databases", {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing databases", e);
      }
    },
  );

  server.registerTool(
    "drh_get_database_by_id",
    {
      title: "Get Database by ID",
      description: "Fetch one database by id. GET /databases/{id}.",
      inputSchema: { databaseId: numericIdSchema("Database id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/databases/${databaseId}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting database", e);
      }
    },
  );

  server.registerTool(
    "drh_get_default_database",
    {
      title: "Get Default Database",
      description: "Fetch the default database. GET /databases/default.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/databases/default", {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting default database", e);
      }
    },
  );

  server.registerTool(
    "drh_list_deleted_databases",
    {
      title: "List Deleted Databases",
      description: "List soft-deleted databases. GET /databases/deleted.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/databases/deleted", {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing deleted databases", e);
      }
    },
  );

  server.registerTool(
    "drh_create_database",
    {
      title: "Create Database",
      description: "Create a database. POST /databases.",
      inputSchema: { body: dbBody, clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/databases", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error creating database", e);
      }
    },
  );

  server.registerTool(
    "drh_update_database",
    {
      title: "Update Database",
      description: "Replace a database. PUT /databases/{id}.",
      inputSchema: {
        databaseId: numericIdSchema("Database id"),
        body: dbBody,
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ databaseId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PUT", `/api-op/v1/databases/${databaseId}`, {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error updating database", e);
      }
    },
  );

  server.registerTool(
    "drh_patch_database",
    {
      title: "Patch Database",
      description: "Partially update a database. PATCH /databases/{id}.",
      inputSchema: {
        databaseId: numericIdSchema("Database id"),
        body: dbBody,
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ databaseId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PATCH", `/api-op/v1/databases/${databaseId}`, {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error patching database", e);
      }
    },
  );

  server.registerTool(
    "drh_put_database_dm_config_set",
    {
      title: "Set Database DM Config Set",
      description: "Set the data-model config set. PUT /databases/{id}/dm-config-set.",
      inputSchema: {
        databaseId: numericIdSchema("Database id"),
        body: z.record(z.unknown()).describe("DM config-set payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ databaseId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "PUT",
            `/api-op/v1/databases/${databaseId}/dm-config-set`,
            { body, clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error setting DM config set", e);
      }
    },
  );

  server.registerTool(
    "drh_delete_database",
    {
      title: "Delete Database",
      description: "Soft-delete a database. DELETE /databases/{id}.",
      inputSchema: { databaseId: numericIdSchema("Database id"), clientId: drhClientIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("DELETE", `/api-op/v1/databases/${databaseId}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error deleting database", e);
      }
    },
  );

  // Enum-consolidation: pause/resume → one tool with a boolean, dispatched to
  // the pause-automations / resume-automations sub-path.
  server.registerTool(
    "drh_set_database_automations_paused",
    {
      title: "Set Database Automations Paused",
      description:
        "Pause or resume a database's automations. POST /databases/{id}/{pause|resume}-automations.",
      inputSchema: {
        databaseId: numericIdSchema("Database id"),
        paused: z.boolean().describe("true = pause automations, false = resume."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ databaseId, paused, clientId }, extra) => {
      const action = paused ? "pause-automations" : "resume-automations";
      try {
        return jsonContent(
          await client.request(
            "POST",
            `/api-op/v1/databases/${databaseId}/${action}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error setting database automations paused", e);
      }
    },
  );
}
