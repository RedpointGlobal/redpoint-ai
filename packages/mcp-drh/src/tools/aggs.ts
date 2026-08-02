import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DRHApiClient } from "../client/drh-api.js";
import {
  drhClientIdSchema,
  stringIdSchema,
  jsonContent,
  errorContent,
  READ_ONLY,
  MUTATING,
} from "./_shared.js";

/**
 * DRH aggregation-schedule tools (5). Aggs REST API under /api-op/v1/aggs/schedule.
 * aggsScheduleId is a STRING (url-encoded into the path). Lifecycle
 * pause/resume/force-run fold into a single control enum (mirrors schedules).
 */
const aggsScheduleIdArg = stringIdSchema("Aggs schedule id (string).");

export function registerAggsTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_list_aggs_schedules",
    {
      title: "List Aggs Schedules",
      description: "List Aggs schedules for a database. GET /aggs/schedule?databaseId=.",
      inputSchema: {
        databaseId: z.number().int().optional().describe("Filter by database id."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ databaseId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/aggs/schedule", {
            query: { databaseId },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing aggs schedules", e);
      }
    },
  );

  server.registerTool(
    "drh_list_aggs_job_templates",
    {
      title: "List Aggs Job Templates",
      description: "List job templates for Aggs schedules. GET /aggs/schedule/aggs-job-templates.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/aggs/schedule/aggs-job-templates", {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing aggs job templates", e);
      }
    },
  );

  server.registerTool(
    "drh_get_aggs_schedule",
    {
      title: "Get Aggs Schedule",
      description: "Fetch one Aggs schedule. GET /aggs/schedule/{id}.",
      inputSchema: { aggsScheduleId: aggsScheduleIdArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ aggsScheduleId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "GET",
            `/api-op/v1/aggs/schedule/${encodeURIComponent(aggsScheduleId)}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error getting aggs schedule", e);
      }
    },
  );

  server.registerTool(
    "drh_update_aggs_schedule",
    {
      title: "Update Aggs Schedule",
      description: "Update an Aggs schedule. PUT /aggs/schedule/{id}.",
      inputSchema: {
        aggsScheduleId: aggsScheduleIdArg,
        body: z.record(z.unknown()).describe("Aggs schedule payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ aggsScheduleId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "PUT",
            `/api-op/v1/aggs/schedule/${encodeURIComponent(aggsScheduleId)}`,
            { body, clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error updating aggs schedule", e);
      }
    },
  );

  // Control enum: pause | resume | force-run → /aggs/schedule/{id}/{action}.
  server.registerTool(
    "drh_control_aggs_schedule",
    {
      title: "Control Aggs Schedule",
      description: "Pause, resume, or force-run an Aggs schedule. POST /aggs/schedule/{id}/{action}.",
      inputSchema: {
        aggsScheduleId: aggsScheduleIdArg,
        action: z.enum(["pause", "resume", "force-run"]).describe("Schedule action."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ aggsScheduleId, action, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "POST",
            `/api-op/v1/aggs/schedule/${encodeURIComponent(aggsScheduleId)}/${action}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error controlling aggs schedule", e);
      }
    },
  );
}
