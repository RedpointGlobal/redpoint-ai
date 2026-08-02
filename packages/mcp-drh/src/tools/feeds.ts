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
 * DRH feed tools (15). Feeds REST API under /api-op/v1/feeds. Numeric feedId.
 * (The UI-enhanced, database-scoped feed reads live in the dashboard batch.)
 * Note feeds use SINGULAR pause-automation / resume-automation sub-paths.
 */
const feedBody = z
  .record(z.unknown())
  .describe("Feed payload (the OpenAPI Feed object).");

export function registerFeedTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_list_feeds",
    {
      title: "List Feeds",
      description:
        "List feeds. GET /feeds, scoped by databaseId or sourceId. Omit both to use the tenant's default database; sort is optional.",
      inputSchema: {
        databaseId: z.number().int().optional().describe("Scope to a database (defaults to the tenant's database if neither this nor sourceId is given)."),
        sourceId: z.number().int().optional().describe("Scope to a source instead of a database."),
        sort: z.string().optional().describe("Sort expression."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, sourceId, sort, clientId }, extra) => {
      try {
        // databaseId OR sourceId scopes the call; when the caller gives neither,
        // fall back to the tenant's default database.
        const dbId =
          databaseId ?? (sourceId != null ? undefined : await client.getDefaultDatabaseId());
        return jsonContent(
          await client.request("GET", "/api-op/v1/feeds", {
            query: { databaseId: dbId, sourceId, sort },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing feeds", e);
      }
    },
  );

  server.registerTool(
    "drh_get_feed_by_id",
    {
      title: "Get Feed by ID",
      description: "Fetch one feed by id. GET /feeds/{id}.",
      inputSchema: { feedId: numericIdSchema("Feed id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ feedId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/feeds/${feedId}`, { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error getting feed", e);
      }
    },
  );

  server.registerTool(
    "drh_get_feed_columns",
    {
      title: "Get Feed Columns (CSV)",
      description: "Fetch a feed's columns as raw CSV. GET /feeds/{id}/columns.",
      inputSchema: { feedId: numericIdSchema("Feed id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ feedId, clientId }, extra) => {
      try {
        const csv = await client.request<string>(
          "GET",
          `/api-op/v1/feeds/${feedId}/columns`,
          { raw: true, clientId, userToken: token(extra) },
        );
        return { content: [{ type: "text" as const, text: String(csv) }] };
      } catch (e) {
        return errorContent("Error getting feed columns", e);
      }
    },
  );

  server.registerTool(
    "drh_get_feed_metadata",
    {
      title: "Get Feed Metadata",
      description: "Fetch a feed's latest metadata. GET /feeds/{id}/meta-data.",
      inputSchema: { feedId: numericIdSchema("Feed id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ feedId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/feeds/${feedId}/meta-data`, { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error getting feed metadata", e);
      }
    },
  );

  server.registerTool(
    "drh_list_feed_versions",
    {
      title: "List Feed Versions",
      description: "List a feed's versions. GET /feeds/{id}/versions.",
      inputSchema: { feedId: numericIdSchema("Feed id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ feedId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/feeds/${feedId}/versions`, { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error listing feed versions", e);
      }
    },
  );

  server.registerTool(
    "drh_get_feed_version",
    {
      title: "Get Feed Version",
      description: "Fetch a specific feed version. GET /feeds/{id}/versions/{version}.",
      inputSchema: {
        feedId: numericIdSchema("Feed id"),
        versionNumber: numericIdSchema("Version number"),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ feedId, versionNumber, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "GET",
            `/api-op/v1/feeds/${feedId}/versions/${versionNumber}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error getting feed version", e);
      }
    },
  );

  server.registerTool(
    "drh_list_feed_match_fields",
    {
      title: "List Feed Match Fields",
      description: "List feed match fields. GET /feeds/match-fields.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/feeds/match-fields", { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error listing feed match fields", e);
      }
    },
  );

  server.registerTool(
    "drh_list_deleted_feeds",
    {
      title: "List Deleted Feeds",
      description: "List soft-deleted feeds. GET /feeds/deleted.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/feeds/deleted", { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error listing deleted feeds", e);
      }
    },
  );

  server.registerTool(
    "drh_create_feed",
    {
      title: "Create Feed",
      description: "Create a feed. POST /feeds.",
      inputSchema: { body: feedBody, clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/feeds", { body, clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error creating feed", e);
      }
    },
  );

  server.registerTool(
    "drh_update_feed",
    {
      title: "Update Feed",
      description: "Replace a feed. PUT /feeds/{id}.",
      inputSchema: { feedId: numericIdSchema("Feed id"), body: feedBody, clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ feedId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PUT", `/api-op/v1/feeds/${feedId}`, { body, clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error updating feed", e);
      }
    },
  );

  server.registerTool(
    "drh_patch_feed",
    {
      title: "Patch Feed",
      description: "Partially update a feed. PATCH /feeds/{id}.",
      inputSchema: { feedId: numericIdSchema("Feed id"), body: feedBody, clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ feedId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PATCH", `/api-op/v1/feeds/${feedId}`, { body, clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error patching feed", e);
      }
    },
  );

  server.registerTool(
    "drh_check_feed_name_availability",
    {
      title: "Check Feed Name Availability",
      description: "Check whether a feed name is available. POST /feeds/check-name-availability.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Name-availability request payload."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/feeds/check-name-availability", { body, clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error checking feed name availability", e);
      }
    },
  );

  server.registerTool(
    "drh_delete_feed",
    {
      title: "Delete Feed",
      description: "Soft-delete a feed. DELETE /feeds/{id}.",
      inputSchema: { feedId: numericIdSchema("Feed id"), clientId: drhClientIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ feedId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("DELETE", `/api-op/v1/feeds/${feedId}`, { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error deleting feed", e);
      }
    },
  );

  // Enum-consolidation: pause/resume (SINGULAR sub-path for feeds).
  server.registerTool(
    "drh_set_feed_automation_paused",
    {
      title: "Set Feed Automation Paused",
      description:
        "Pause or resume a feed's automation. POST /feeds/{id}/{pause|resume}-automation.",
      inputSchema: {
        feedId: numericIdSchema("Feed id"),
        paused: z.boolean().describe("true = pause automation, false = resume."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ feedId, paused, clientId }, extra) => {
      const action = paused ? "pause-automation" : "resume-automation";
      try {
        return jsonContent(
          await client.request("POST", `/api-op/v1/feeds/${feedId}/${action}`, { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error setting feed automation paused", e);
      }
    },
  );

  // Enum-consolidation: enable/disable.
  server.registerTool(
    "drh_set_feed_enabled",
    {
      title: "Set Feed Enabled",
      description: "Enable or disable a feed. POST /feeds/{id}/{enable|disable}.",
      inputSchema: {
        feedId: numericIdSchema("Feed id"),
        enabled: z.boolean().describe("true = enable, false = disable."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ feedId, enabled, clientId }, extra) => {
      const action = enabled ? "enable" : "disable";
      try {
        return jsonContent(
          await client.request("POST", `/api-op/v1/feeds/${feedId}/${action}`, { clientId, userToken: token(extra) }),
        );
      } catch (e) {
        return errorContent("Error setting feed enabled", e);
      }
    },
  );
}
