import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DRHApiClient } from "../client/drh-api.js";
import {
  drhClientIdSchema,
  jsonContent,
  errorContent,
  READ_ONLY,
  MUTATING,
  DESTRUCTIVE,
} from "./_shared.js";

/**
 * DRH subject-area tools (6). Subject Areas REST API under
 * /api-op/v1/subject-areas. Note subjectAreaId is a STRING (url-encoded into the
 * path). Upsert is a single PUT (create-or-update). Columns export returns raw CSV.
 */
const subjectAreaIdArg = z.string().describe("Subject area id (string).");

export function registerSubjectAreaTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_list_subject_areas",
    {
      title: "List Subject Areas",
      description: "List subject areas. GET /subject-areas.",
      inputSchema: {
        clientConfigCheck: z
          .boolean()
          .optional()
          .describe("If true, cross-check against the client config."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ clientConfigCheck, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/subject-areas", {
            query: { clientConfigCheck },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing subject areas", e);
      }
    },
  );

  server.registerTool(
    "drh_upsert_subject_area",
    {
      title: "Upsert Subject Area",
      description: "Create or update a subject area. PUT /subject-areas.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Subject-area payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PUT", "/api-op/v1/subject-areas", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error upserting subject area", e);
      }
    },
  );

  server.registerTool(
    "drh_list_deleted_subject_areas",
    {
      title: "List Deleted Subject Areas",
      description: "List soft-deleted subject areas. GET /subject-areas/deleted.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/subject-areas/deleted", {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing deleted subject areas", e);
      }
    },
  );

  server.registerTool(
    "drh_get_subject_area",
    {
      title: "Get Subject Area",
      description: "Fetch one subject area by id. GET /subject-areas/{id}.",
      inputSchema: { subjectAreaId: subjectAreaIdArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ subjectAreaId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "GET",
            `/api-op/v1/subject-areas/${encodeURIComponent(subjectAreaId)}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error getting subject area", e);
      }
    },
  );

  server.registerTool(
    "drh_delete_subject_area",
    {
      title: "Delete Subject Area",
      description: "Delete a subject area. DELETE /subject-areas/{id}.",
      inputSchema: { subjectAreaId: subjectAreaIdArg, clientId: drhClientIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ subjectAreaId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "DELETE",
            `/api-op/v1/subject-areas/${encodeURIComponent(subjectAreaId)}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error deleting subject area", e);
      }
    },
  );

  server.registerTool(
    "drh_get_subject_area_columns",
    {
      title: "Get Subject Area Columns (CSV)",
      description: "Export a subject area's columns as raw CSV. GET /subject-areas/{id}/columns.",
      inputSchema: { subjectAreaId: subjectAreaIdArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ subjectAreaId, clientId }, extra) => {
      try {
        const csv = await client.request<string>(
          "GET",
          `/api-op/v1/subject-areas/${encodeURIComponent(subjectAreaId)}/columns`,
          { raw: true, clientId, userToken: token(extra) },
        );
        return { content: [{ type: "text" as const, text: String(csv) }] };
      } catch (e) {
        return errorContent("Error getting subject area columns", e);
      }
    },
  );
}
