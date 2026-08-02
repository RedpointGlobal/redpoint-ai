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
  DESTRUCTIVE,
} from "./_shared.js";

/**
 * DRH schedule tools (9). Schedules V3 REST API under /api-op/v1/schedules-v3.
 * scheduleId and jobId are STRINGS (url-encoded into the path). Lifecycle
 * pause/resume/force-run fold into a single control enum (mirrors match-runs);
 * restart is separate (it takes an optional stepId).
 */
const scheduleIdArg = stringIdSchema("Schedule id (string).");

export function registerScheduleTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_list_schedules",
    {
      title: "List Schedules",
      description:
        "List schedules, optionally filtered. GET /schedules-v3. Filters (all optional): databaseId, sourceId, feedId, generatedType, name, jobSourceId, jobFeedId, jobAutomationType, scheduleFrequency, deleted.",
      inputSchema: {
        databaseId: z.number().int().optional().describe("Filter by database id."),
        sourceId: z.number().int().optional().describe("Filter by source id."),
        feedId: z.number().int().optional().describe("Filter by feed id."),
        generatedType: z.string().optional().describe("Filter by generated type."),
        name: z.string().optional().describe("Filter by schedule name."),
        jobSourceId: z.number().int().optional().describe("Filter by job source id."),
        jobFeedId: z.number().int().optional().describe("Filter by job feed id."),
        jobAutomationType: z.string().optional().describe("Filter by job automation type."),
        scheduleFrequency: z.string().optional().describe("Filter by schedule frequency."),
        deleted: z.boolean().optional().describe("Include deleted schedules."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ clientId, ...filters }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/schedules-v3", {
            query: filters,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing schedules", e);
      }
    },
  );

  server.registerTool(
    "drh_upsert_schedule",
    {
      title: "Upsert Schedule",
      description: "Create or update a schedule. PUT /schedules-v3.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Schedule payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PUT", "/api-op/v1/schedules-v3", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error upserting schedule", e);
      }
    },
  );

  server.registerTool(
    "drh_calculate_schedule_times",
    {
      title: "Calculate Schedule Times",
      description: "Calculate schedule times (no persistence). POST /schedules-v3/calculate-schedule-times.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Calculation request payload."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/schedules-v3/calculate-schedule-times", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error calculating schedule times", e);
      }
    },
  );

  server.registerTool(
    "drh_get_schedule_by_job",
    {
      title: "Get Schedule by Job",
      description: "Fetch the schedule for a job (even if the job is in a pre-generated state). GET /schedules-v3/jobs/{jobId}.",
      inputSchema: { jobId: stringIdSchema("Job id (string)."), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ jobId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/schedules-v3/jobs/${encodeURIComponent(jobId)}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting schedule by job", e);
      }
    },
  );

  server.registerTool(
    "drh_get_schedule",
    {
      title: "Get Schedule",
      description: "Fetch one schedule (optionally a specific version). GET /schedules-v3/{id}?versionNumber=.",
      inputSchema: {
        scheduleId: scheduleIdArg,
        versionNumber: z.number().int().optional().describe("Specific version to fetch."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ scheduleId, versionNumber, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", `/api-op/v1/schedules-v3/${encodeURIComponent(scheduleId)}`, {
            query: { versionNumber },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error getting schedule", e);
      }
    },
  );

  server.registerTool(
    "drh_patch_schedule",
    {
      title: "Patch Schedule",
      description: "Partially update a schedule. PATCH /schedules-v3/{id}.",
      inputSchema: {
        scheduleId: scheduleIdArg,
        body: z.record(z.unknown()).describe("Schedule patch payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ scheduleId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("PATCH", `/api-op/v1/schedules-v3/${encodeURIComponent(scheduleId)}`, {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error patching schedule", e);
      }
    },
  );

  server.registerTool(
    "drh_delete_schedule",
    {
      title: "Delete Schedule",
      description: "Delete a schedule. DELETE /schedules-v3/{id}.",
      inputSchema: { scheduleId: scheduleIdArg, clientId: drhClientIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ scheduleId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("DELETE", `/api-op/v1/schedules-v3/${encodeURIComponent(scheduleId)}`, {
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error deleting schedule", e);
      }
    },
  );

  // Control enum: pause | resume | force-run → /schedules-v3/{id}/{action}.
  server.registerTool(
    "drh_control_schedule",
    {
      title: "Control Schedule",
      description: "Pause, resume, or force-run a schedule. POST /schedules-v3/{id}/{action}.",
      inputSchema: {
        scheduleId: scheduleIdArg,
        action: z.enum(["pause", "resume", "force-run"]).describe("Schedule action."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ scheduleId, action, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "POST",
            `/api-op/v1/schedules-v3/${encodeURIComponent(scheduleId)}/${action}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error controlling schedule", e);
      }
    },
  );

  // Restart is distinct — it optionally resumes at a specific step.
  server.registerTool(
    "drh_restart_schedule",
    {
      title: "Restart Schedule",
      description: "Restart a schedule, optionally at a specific step. POST /schedules-v3/{id}/restart?stepId=.",
      inputSchema: {
        scheduleId: scheduleIdArg,
        stepId: z.number().int().optional().describe("Step to restart at (optional)."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ scheduleId, stepId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "POST",
            `/api-op/v1/schedules-v3/${encodeURIComponent(scheduleId)}/restart`,
            { query: { stepId }, clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error restarting schedule", e);
      }
    },
  );
}
