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
 * DRH automation-log tools (5). Automation Logs REST API under
 * /api-op/v1/automations. automationId is a STRING (url-encoded into the path).
 * The test create/delete pair lives under /automations/test.
 */
const automationIdArg = stringIdSchema("Automation log id (string).");

export function registerAutomationLogTools(server: McpServer, client: DRHApiClient) {
  const token = (extra: { authInfo?: { token?: string } }) =>
    extra.authInfo?.token;

  server.registerTool(
    "drh_search_automation_logs",
    {
      title: "Search Automation Logs",
      description: "Search automation logs. POST /automations/search.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Search request payload."),
        clientId: drhClientIdSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/automations/search", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error searching automation logs", e);
      }
    },
  );

  server.registerTool(
    "drh_get_automation_log",
    {
      title: "Get Automation Log",
      description: "Fetch one automation log. GET /automations/{id}.",
      inputSchema: { automationId: automationIdArg, clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ automationId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "GET",
            `/api-op/v1/automations/${encodeURIComponent(automationId)}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error getting automation log", e);
      }
    },
  );

  server.registerTool(
    "drh_patch_automation_log",
    {
      title: "Patch Automation Log",
      description: "Partially update an automation log. PATCH /automations/{id}.",
      inputSchema: {
        automationId: automationIdArg,
        body: z.record(z.unknown()).describe("Automation-log patch payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ automationId, body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "PATCH",
            `/api-op/v1/automations/${encodeURIComponent(automationId)}`,
            { body, clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error patching automation log", e);
      }
    },
  );

  server.registerTool(
    "drh_create_test_automation_log",
    {
      title: "Create Test Automation Log",
      description: "Create a test automation log. POST /automations/test.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Test automation-log payload."),
        clientId: drhClientIdSchema,
      },
      annotations: MUTATING,
    },
    async ({ body, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request("POST", "/api-op/v1/automations/test", {
            body,
            clientId,
            userToken: token(extra),
          }),
        );
      } catch (e) {
        return errorContent("Error creating test automation log", e);
      }
    },
  );

  server.registerTool(
    "drh_delete_automation_log",
    {
      title: "Delete Automation Log",
      description: "Delete a (test) automation log. DELETE /automations/test/{id}.",
      inputSchema: { automationId: automationIdArg, clientId: drhClientIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ automationId, clientId }, extra) => {
      try {
        return jsonContent(
          await client.request(
            "DELETE",
            `/api-op/v1/automations/test/${encodeURIComponent(automationId)}`,
            { clientId, userToken: token(extra) },
          ),
        );
      } catch (e) {
        return errorContent("Error deleting automation log", e);
      }
    },
  );
}
