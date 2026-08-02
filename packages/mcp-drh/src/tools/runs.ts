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
} from "./_shared.js";

/**
 * DRH run-tracking tools (12): feed-runs (6), match-runs (4), rpi-sync-runs (2).
 * Numeric run ids. (UI database-scoped run listings live in the dashboard batch.)
 */
export function registerRunTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  // ---- feed-runs (6) ----
  server.registerTool(
    "drh_list_feed_runs",
    {
      title: "List Feed Runs",
      description: "List feed runs for a feed. GET /feed-runs?feedId= (feedId is required). Optional count.",
      inputSchema: {
        feedId: numericIdSchema("Feed id (numeric) to scope the runs — required."),
        count: z.number().int().optional().describe("Max number of runs to return."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ feedId, count, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("GET", "/api-op/v1/feed-runs", {
            query: { feedId, count },
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error listing feed runs", e);
      }
    },
  );

  server.registerTool(
    "drh_get_feed_run_by_id",
    {
      title: "Get Feed Run by ID",
      description: "Fetch one feed run. GET /feed-runs/{id}.",
      inputSchema: { feedRunId: numericIdSchema("Feed run id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ feedRunId, clientId }, extra) => {
      try {
        return jsonContent(await client.request("GET", `/api-op/v1/feed-runs/${feedRunId}`, { clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error getting feed run", e);
      }
    },
  );

  server.registerTool(
    "drh_get_feed_run_record_metrics",
    {
      title: "Get Feed Run Record Metrics",
      description: "Fetch a feed run's record metrics. GET /feed-runs/{id}/record-metrics.",
      inputSchema: { feedRunId: numericIdSchema("Feed run id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ feedRunId, clientId }, extra) => {
      try {
        return jsonContent(await client.request("GET", `/api-op/v1/feed-runs/${feedRunId}/record-metrics`, { clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error getting feed run record metrics", e);
      }
    },
  );

  server.registerTool(
    "drh_search_feed_runs",
    {
      title: "Search Feed Runs",
      description:
        "Search feed runs. POST /feed-runs/search. Body: { searchParams, sortParams, pageSelector: { pageSize, pageNumber, useCache } }.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Search request ({searchParams, sortParams, pageSelector})."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(await client.request("POST", "/api-op/v1/feed-runs/search", { body, clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error searching feed runs", e);
      }
    },
  );

  server.registerTool(
    "drh_create_feed_run",
    {
      title: "Create Feed Run",
      description: "Start a feed run. POST /feed-runs.",
      inputSchema: { body: z.record(z.unknown()).describe("Feed-run request payload."), clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(await client.request("POST", "/api-op/v1/feed-runs", { body, clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error creating feed run", e);
      }
    },
  );

  server.registerTool(
    "drh_patch_feed_run",
    {
      title: "Patch Feed Run",
      description: "Update a feed run. PATCH /feed-runs/{id}.",
      inputSchema: {
        feedRunId: numericIdSchema("Feed run id"),
        body: z.record(z.unknown()).describe("Feed-run patch payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ feedRunId, body, clientId }, extra) => {
      try {
        return jsonContent(await client.request("PATCH", `/api-op/v1/feed-runs/${feedRunId}`, { body, clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error patching feed run", e);
      }
    },
  );

  // ---- match-runs (4) ----
  server.registerTool(
    "drh_create_match_run",
    {
      title: "Create Match Run",
      description: "Start a match run. POST /match-runs.",
      inputSchema: { body: z.record(z.unknown()).describe("Match-run request payload."), clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(await client.request("POST", "/api-op/v1/match-runs", { body, clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error creating match run", e);
      }
    },
  );

  server.registerTool(
    "drh_get_match_run_by_id",
    {
      title: "Get Match Run by ID",
      description: "Fetch one match run. GET /match-runs/{id}.",
      inputSchema: { matchRunId: numericIdSchema("Match run id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ matchRunId, clientId }, extra) => {
      try {
        return jsonContent(await client.request("GET", `/api-op/v1/match-runs/${matchRunId}`, { clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error getting match run", e);
      }
    },
  );

  server.registerTool(
    "drh_get_match_run_schedule",
    {
      title: "Get Match Run Schedule",
      description: "Fetch the match-run schedule. GET /match-runs/schedule.",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        return jsonContent(await client.request("GET", "/api-op/v1/match-runs/schedule", { clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error getting match run schedule", e);
      }
    },
  );

  // Control enum: pause | resume | force-run → /match-runs/schedule/{action}.
  server.registerTool(
    "drh_control_match_run_schedule",
    {
      title: "Control Match Run Schedule",
      description:
        "Pause, resume, or force-run the match-run schedule. POST /match-runs/schedule/{action}.",
      inputSchema: {
        action: z.enum(["pause", "resume", "force-run"]).describe("Schedule action."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ action, clientId }, extra) => {
      try {
        return jsonContent(await client.request("POST", `/api-op/v1/match-runs/schedule/${action}`, { clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error controlling match run schedule", e);
      }
    },
  );

  // ---- rpi-sync-runs (2) ----
  server.registerTool(
    "drh_create_rpi_sync_run",
    {
      title: "Create RPI Sync Run",
      description: "Start an RPI sync run. POST /rpi-sync-runs.",
      inputSchema: { body: z.record(z.unknown()).describe("RPI-sync-run request payload."), clientId: drhClientIdSchema },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(await client.request("POST", "/api-op/v1/rpi-sync-runs", { body, clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error creating RPI sync run", e);
      }
    },
  );

  server.registerTool(
    "drh_get_rpi_sync_run_by_id",
    {
      title: "Get RPI Sync Run by ID",
      description: "Fetch one RPI sync run. GET /rpi-sync-runs/{id}.",
      inputSchema: { rpiSyncRunId: numericIdSchema("RPI sync run id"), clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ rpiSyncRunId, clientId }, extra) => {
      try {
        return jsonContent(await client.request("GET", `/api-op/v1/rpi-sync-runs/${rpiSyncRunId}`, { clientId, userToken: token(extra) }));
      } catch (e) {
        return errorContent("Error getting RPI sync run", e);
      }
    },
  );
}
