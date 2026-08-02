import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DRHApiClient } from "../client/drh-api.js";
import { drhClientIdSchema, jsonContent, errorContent, READ_ONLY } from "./_shared.js";

/**
 * DRH connectivity/auth tool (1). `drh_verify_connection` hits the health
 * endpoint through the DRHApiClient, which exercises the full auth path
 * (proxy signon → Bearer token) on the way — so a success confirms both
 * reachability and working credentials; a failure surfaces the DRH error.
 */
export function registerAuthTools(server: McpServer, client: DRHApiClient) {
  server.registerTool(
    "drh_verify_connection",
    {
      title: "Verify Data Readiness Hub Connection",
      description:
        "Verify connectivity + auth to the Data Readiness Hub instance. GET /healthcheck/version through the authenticated client (exercises the proxy signon).",
      inputSchema: { clientId: drhClientIdSchema },
      annotations: READ_ONLY,
    },
    async ({ clientId }, extra) => {
      try {
        const version = await client.request(
          "GET",
          "/api-op/v1/healthcheck/version",
          { clientId, userToken: extra.authInfo?.token },
        );
        return jsonContent({ connected: true, version });
      } catch (e) {
        return errorContent("Data Readiness Hub connection failed", e);
      }
    },
  );
}
