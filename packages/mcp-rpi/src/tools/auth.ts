import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { RPIAuthService } from "../client/rpi-auth.js";
import type { OidcVerifier } from "../client/oidc-discovery.js";
import { createToolRegistrar } from "../tool-categories.js";

export function registerAuthTools(
  server: McpServer,
  rpiClient: RPIApiClient,
  authService: RPIAuthService,
  oidcVerifier?: OidcVerifier | null,
) {
  const registerTool = createToolRegistrar(server, "auth");

  registerTool(
    "verify_connection",
    {
      title: "Verify RPI Connection",
      description:
        "Test connectivity and authentication to the RPI instance. Returns connection status, auth type, and available login methods.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const results: Record<string, unknown> = {};
      const userToken = extra.authInfo?.token;
      results.userTokenPresent = !!userToken;

      // OIDC detection status
      results.oidcEnabled = !!oidcVerifier;
      if (oidcVerifier) {
        results.oidcIssuer = oidcVerifier.config.issuer;
        results.oidcJwksUri = oidcVerifier.config.jwksUri;
        results.oidcAudience = oidcVerifier.config.audience ?? "(not set)";
      }

      // Check proxy token
      results.proxyEnabled = authService.proxyEnabled;
      if (authService.proxyEnabled) {
        try {
          await authService.getProxyToken();
          results.proxyTokenValid = true;
        } catch (error) {
          results.proxyTokenValid = false;
          results.proxyTokenError =
            error instanceof Error ? error.message : String(error);
        }
      }

      // Fetch login settings (no auth required)
      try {
        results.loginSettings = await authService.getLoginSettings();
      } catch (error) {
        results.loginSettingsError =
          error instanceof Error ? error.message : String(error);
      }

      // Test API call using user token if available, otherwise proxy
      try {
        await rpiClient.get(userToken, "/info/version");
        results.apiCallSuccess = true;
      } catch (error) {
        results.apiCallSuccess = false;
        results.apiCallError =
          error instanceof Error ? error.message : String(error);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );
}
