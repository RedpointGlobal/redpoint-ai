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
 * DRH source tools (10). Endpoints under /api-op/v1/sources. Numeric sourceId.
 * Lifecycle actions consolidated into boolean-arg tools (paused, enabled).
 */
const srcBody = z
  .record(z.unknown())
  .describe("Source payload (the OpenAPI Source object).");

export function registerSourceTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_list_sources",
    {
      title: "List Sources",
      description: "List sources for a database. GET /sources?databaseId= (defaults to the tenant's database).",
      inputSchema: {
        databaseId: databaseIdArg,
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        const dbId = await resolveDatabaseId(databaseId, client);
        return jsonContent(
          await client.request("GET", "/api-op/v1/sources", {
            query: { databaseId: dbId },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing sources", e);
      }
    },
  );

  server.registerTool(
    "drh_get_source_by_id",
    {
      title: "Get Source by ID",
      description: "Fetch one source by id. GET /sources/{id}.",
      inputSchema: { sourceId: numericIdSchema("Source id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ sourceId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/sources/${sourceId}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting source", e);
      }
    },
  );

  server.registerTool(
    "drh_list_deleted_sources",
    {
      title: "List Deleted Sources",
      description: "List soft-deleted sources. GET /sources/deleted.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/sources/deleted", {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing deleted sources", e);
      }
    },
  );

  server.registerTool(
    "drh_list_source_job_templates",
    {
      title: "List Source Job Templates",
      description:
        "List source scheduling job templates. GET /sources/schedule/source-job-templates.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "GET",
            "/api-op/v1/sources/schedule/source-job-templates",
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error listing source job templates", e);
      }
    },
  );

  server.registerTool(
    "drh_create_source",
    {
      title: "Create Source",
      description: "Create a source. POST /sources.",
      inputSchema: { body: srcBody, clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/sources", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error creating source", e);
      }
    },
  );

  server.registerTool(
    "drh_update_source",
    {
      title: "Update Source",
      description: "Replace a source. PUT /sources/{id}.",
      inputSchema: {
        sourceId: numericIdSchema("Source id"),
        body: srcBody,
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ sourceId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PUT", `/api-op/v1/sources/${sourceId}`, {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error updating source", e);
      }
    },
  );

  server.registerTool(
    "drh_check_source_name_availability",
    {
      title: "Check Source Name Availability",
      description:
        "Check whether a source name is available. POST /sources/check-name-availability.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Name-availability request payload."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "POST",
            "/api-op/v1/sources/check-name-availability",
            { body, clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error checking source name availability", e);
      }
    },
  );

  server.registerTool(
    "drh_delete_source",
    {
      title: "Delete Source",
      description: "Soft-delete a source. DELETE /sources/{id}.",
      inputSchema: { sourceId: numericIdSchema("Source id"), clientId: drhClientIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ sourceId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("DELETE", `/api-op/v1/sources/${sourceId}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error deleting source", e);
      }
    },
  );

  // Enum-consolidation: pause/resume automations.
  server.registerTool(
    "drh_set_source_automations_paused",
    {
      title: "Set Source Automations Paused",
      description:
        "Pause or resume a source's automations. POST /sources/{id}/{pause|resume}-automations.",
      inputSchema: {
        sourceId: numericIdSchema("Source id"),
        paused: z.boolean().describe("true = pause automations, false = resume."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ sourceId, paused, clientId }, extra) => {
      const action = paused ? "pause-automations" : "resume-automations";
      try {
        return jsonContent(
          await client.request("POST", `/api-op/v1/sources/${sourceId}/${action}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error setting source automations paused", e);
      }
    },
  );

  // Enum-consolidation: enable/disable.
  server.registerTool(
    "drh_set_source_enabled",
    {
      title: "Set Source Enabled",
      description:
        "Enable or disable a source. POST /sources/{id}/{enable|disable}.",
      inputSchema: {
        sourceId: numericIdSchema("Source id"),
        enabled: z.boolean().describe("true = enable, false = disable."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ sourceId, enabled, clientId }, extra) => {
      const action = enabled ? "enable" : "disable";
      try {
        return jsonContent(
          await client.request("POST", `/api-op/v1/sources/${sourceId}/${action}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error setting source enabled", e);
      }
    },
  );
}
