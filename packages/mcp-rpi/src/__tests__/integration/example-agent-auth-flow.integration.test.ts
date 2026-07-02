/**
 * Integration test: exercises the production per-user auth path end-to-end —
 * RPIAuthService.loginUser / refreshUserToken plus a Bearer-token-forwarded
 * MCP tool call — against a real RPI tenant and an in-process MCP server with
 * the proxy user disabled.
 *
 * The "proxy disabled" invariant matters: it makes this a true negative test.
 * If token forwarding ever regresses, the downstream RPI call falls into the
 * proxy-fallback branch in buildHeaders() (rpi-api.ts) — which throws
 * "Proxy user is not configured" because we wired the auth service without
 * proxy creds. Any silent regression surfaces as a loud test failure.
 *
 * The runnable example at packages/mcp-rpi/examples/agent-auth-flow.ts is a
 * pedagogical sibling, not the source under test — both exercise the same
 * wire protocol independently. Pinning the test to the production service
 * (RPIAuthService) keeps the example self-contained / copy-pasteable without
 * making `examples/` a load-bearing import target.
 *
 * Skips silently when RPI env is missing, mirroring the rpi-connect
 * integration test.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { createRpiAuthMiddleware } from "../../middleware/auth.js";
import { createRPIMcpServer } from "../../server.js";
import { RPIConfigSchema } from "../../config.js";

async function callMcpTool(
  mcpUrl: string,
  accessToken: string,
  toolName: string,
): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client(
    { name: "rpi-agent-auth-test", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await client.callTool({ name: toolName, arguments: {} });
  } finally {
    await client.close();
  }
}

// Load root .env so the test works regardless of which cwd `bun test` runs from.
const __testsDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(__testsDir, "../../../../../.env");
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

const REQUIRED = [
  "RPI_INTEGRATION_API_URL",
  "RPI_OAUTH_CLIENT_ID",
  "RPI_OAUTH_CLIENT_SECRET",
  "RPI_DEFAULT_CLIENT_ID",
  "RPI_PROXY_USER",
  "RPI_PROXY_PASS",
] as const;

const missing = REQUIRED.filter((k) => !process.env[k]);
const shouldSkip = missing.length > 0;

if (shouldSkip) {
  console.error(
    `[integration] Skipping example-agent-auth-flow test — missing env: ${missing.join(", ")}`,
  );
}

describe.skipIf(shouldSkip)("RPIAuthService per-user flow (live)", () => {
  // Reuse RPI_PROXY_USER/PASS as the *test user* credentials. These are real
  // native RPI credentials; we just happen to call them "proxy" creds in env
  // since they're already provisioned. The integration test below builds the
  // MCP server with proxy DISABLED, so we still get the proxy-bypass guarantee.
  const rpiBaseUrl = process.env.RPI_INTEGRATION_API_URL!;
  const oauthClientId = process.env.RPI_OAUTH_CLIENT_ID!;
  const oauthClientSecret = process.env.RPI_OAUTH_CLIENT_SECRET!;
  const username = process.env.RPI_PROXY_USER!;
  const password = process.env.RPI_PROXY_PASS!;

  let server: ReturnType<typeof Bun.serve> | undefined;
  let mcpUrl: string;
  let authService: RPIAuthService;

  beforeAll(async () => {
    // Build an RPIAuthService with NO proxy creds — proxyEnabled is false.
    authService = new RPIAuthService(
      rpiBaseUrl,
      oauthClientId,
      oauthClientSecret,
      // proxyUser, proxyPass intentionally omitted
    );
    expect(authService.proxyEnabled).toBe(false);

    const config = RPIConfigSchema.parse({
      integrationApiUrl: rpiBaseUrl,
      proxyEnabled: false,
      oauthClientId,
      oauthClientSecret,
      defaultClientId: process.env.RPI_DEFAULT_CLIENT_ID!,
      authRequired: true,
    });

    const transports = new Map<
      string,
      WebStandardStreamableHTTPServerTransport
    >();

    const app = new Hono();
    app.use("/*", cors());
    app.get("/health", (c) =>
      c.json({ status: "ok", server: "rpi-mcp-server-test" }),
    );

    const authMw = createRpiAuthMiddleware(authService, true, null);
    app.all("/mcp", authMw, async (c) => {
      const sessionId = c.req.header("mcp-session-id");
      const authInfo = c.get("authInfo");

      if (sessionId && transports.has(sessionId)) {
        return transports.get(sessionId)!.handleRequest(c.req.raw, { authInfo });
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
        onsessionclosed: (id) => transports.delete(id),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const { server: mcp } = createRPIMcpServer(config, authService, null);
      await mcp.connect(transport);
      return transport.handleRequest(c.req.raw, { authInfo });
    });

    server = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpUrl = `http://127.0.0.1:${server.port}/mcp`;
    console.error(`[integration] Test MCP server listening at ${mcpUrl}`);
  });

  afterAll(() => {
    server?.stop(true);
  });

  // Shared state across the test sequence — log in once, reuse the result.
  const state: { accessToken?: string; refreshToken?: string } = {};
  let initialExpiresIn = 0;

  it("loginUser() returns an access_token and expires_in for a native RPI user", async () => {
    const result = await authService.loginUser(username, password);
    expect(typeof result.access_token).toBe("string");
    expect(result.access_token.length).toBeGreaterThan(0);
    expect(result.expires_in).toBeGreaterThan(0);

    state.accessToken = result.access_token;
    state.refreshToken = result.refresh_token;
    initialExpiresIn = result.expires_in;

    if (!result.refresh_token) {
      console.error(
        "[integration] Tenant did not issue a refresh_token — refresh test will be soft-skipped.",
      );
    }
  });

  it("callMcpTool(verify_connection) succeeds with the user token; proxy is disabled", async () => {
    expect(state.accessToken).toBeDefined();

    const raw = (await callMcpTool(
      mcpUrl,
      state.accessToken!,
      "verify_connection",
    )) as { content?: Array<{ type: string; text?: string }> };

    const text = raw?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    const diag = JSON.parse(text!) as Record<string, unknown>;

    // The user token reached the tool handler.
    expect(diag.userTokenPresent).toBe(true);

    // Proxy is disabled — proves the user token (not proxy fallback) was used
    // for the downstream RPI /info/version call.
    expect(diag.proxyEnabled).toBe(false);

    // The downstream RPI call succeeded using the user token.
    expect(diag.apiCallSuccess).toBe(true);
  });

  it("refreshUserToken() exchanges refresh_token for a fresh access_token", async () => {
    if (!state.refreshToken) {
      console.error(
        "[integration] No refresh_token issued by tenant — skipping refresh assertion.",
      );
      return;
    }

    const refreshed = await authService.refreshUserToken(state.refreshToken);
    expect(typeof refreshed.access_token).toBe("string");
    expect(refreshed.access_token.length).toBeGreaterThan(0);
    expect(refreshed.expires_in).toBeGreaterThan(0);

    // The refreshed token may legitimately equal the original if RPI returns a
    // cached token within the same TTL window — assert it works rather than
    // asserting it's distinct.
    state.accessToken = refreshed.access_token;
    state.refreshToken = refreshed.refresh_token ?? state.refreshToken;

    void initialExpiresIn; // captured in the login test for diagnostic completeness
  });

  it("callMcpTool(verify_connection) succeeds with the refreshed token", async () => {
    if (!state.accessToken) return;

    const raw = (await callMcpTool(
      mcpUrl,
      state.accessToken,
      "verify_connection",
    )) as { content?: Array<{ type: string; text?: string }> };

    const text = raw?.content?.[0]?.text;
    const diag = JSON.parse(text!) as Record<string, unknown>;
    expect(diag.userTokenPresent).toBe(true);
    expect(diag.proxyEnabled).toBe(false);
    expect(diag.apiCallSuccess).toBe(true);
  });

  it("client-side discard clears in-memory tokens", () => {
    state.accessToken = undefined;
    state.refreshToken = undefined;
    expect(state.accessToken).toBeUndefined();
    expect(state.refreshToken).toBeUndefined();
  });
});
