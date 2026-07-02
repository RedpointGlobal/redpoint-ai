import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load root .env for monorepo — Bun only auto-loads .env from cwd.
const __mcpDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(__mcpDir, "../../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf("#");
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRPIMcpServer } from "./server.js";
import { RPIConfigSchema, resolveProxyEnabled } from "./config.js";
import { RPIAuthService } from "./client/rpi-auth.js";

if (!process.env.RPI_INTEGRATION_API_URL) {
  console.error(
    "ERROR: RPI_INTEGRATION_API_URL is required. Set it to your RPI Integration API root URL (e.g. https://rpi.your-company.com)",
  );
  process.exit(1);
}

if (!process.env.RPI_OAUTH_CLIENT_ID || !process.env.RPI_OAUTH_CLIENT_SECRET) {
  console.error(
    "ERROR: RPI_OAUTH_CLIENT_ID and RPI_OAUTH_CLIENT_SECRET are required. Set them to your RPI OAuth2 client credentials (used for the /connect/token password grant).",
  );
  process.exit(1);
}

if (!process.env.RPI_DEFAULT_CLIENT_ID) {
  console.error(
    "ERROR: RPI_DEFAULT_CLIENT_ID is required. Set it to the RPI tenant/workspace client ID used as the default value for the X-ClientID header.",
  );
  process.exit(1);
}

let proxyEnabled: boolean;
try {
  proxyEnabled = resolveProxyEnabled();
} catch (err) {
  console.error(`ERROR: ${(err as Error).message}`);
  process.exit(1);
}

const config = RPIConfigSchema.parse({
  integrationApiUrl: process.env.RPI_INTEGRATION_API_URL,
  proxyEnabled,
  proxyUser: proxyEnabled ? process.env.RPI_PROXY_USER : undefined,
  proxyPass: proxyEnabled ? process.env.RPI_PROXY_PASS : undefined,
  oauthClientId: process.env.RPI_OAUTH_CLIENT_ID,
  oauthClientSecret: process.env.RPI_OAUTH_CLIENT_SECRET,
  defaultClientId: process.env.RPI_DEFAULT_CLIENT_ID,
  authRequired: false, // stdio mode — caller controls the process directly
});

const authService = new RPIAuthService(
  config.integrationApiUrl,
  config.oauthClientId,
  config.oauthClientSecret,
  config.proxyUser,
  config.proxyPass,
);

const { server } = createRPIMcpServer(config, authService);
const transport = new StdioServerTransport();
await server.connect(transport);

// IMPORTANT: use console.error, never console.log (breaks stdio protocol)
console.error("RPI MCP Server started (stdio)");
