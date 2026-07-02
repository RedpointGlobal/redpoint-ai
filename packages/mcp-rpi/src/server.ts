import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "./client/rpi-api.js";
import type { RPIAuthService } from "./client/rpi-auth.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerClientTools } from "./tools/clients.js";
import { registerFileSystemTools } from "./tools/file-system.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerInteractionTools } from "./tools/interactions.js";
import { registerSelectionRuleTools } from "./tools/selection-rules.js";
import type { OidcVerifier } from "./client/oidc-discovery.js";
import type { RPIConfig } from "./config.js";
import { installToolFilter } from "./tool-filter.js";

export function createRPIMcpServer(
  rpiConfig: RPIConfig,
  authService: RPIAuthService,
  oidcVerifier?: OidcVerifier | null,
) {
  const server = new McpServer({
    name: "rpi-mcp-server",
    version: "0.1.0",
  });

  const rpiClient = new RPIApiClient(
    rpiConfig.integrationApiUrl,
    authService,
    rpiConfig.defaultClientId,
  );

  // Register all tool domains rewritten against real RPI API paths.
  // Fictional-path domains (campaigns, content, profiles, channels, reporting,
  // realtime) were deleted; rebuild them on demand against verified endpoints.
  registerAudienceTools(server, rpiClient);
  registerAdminTools(server, rpiClient);
  registerAuthTools(server, rpiClient, authService, oidcVerifier);
  registerClientTools(server, rpiClient);
  registerFileSystemTools(server, rpiClient);
  registerFolderTools(server, rpiClient);
  registerInteractionTools(server, rpiClient);
  registerSelectionRuleTools(server, rpiClient);

  installToolFilter(server);

  return { server, rpiClient };
}
