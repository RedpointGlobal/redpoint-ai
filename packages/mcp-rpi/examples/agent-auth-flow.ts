/**
 * Per-user RPI authentication for AI agents.
 *
 * Demonstrates how an agent can:
 *   1. Log in to RPI as a specific native user via /connect/token (password grant).
 *   2. Pass the resulting access token to the MCP server so RPI applies that
 *      user's permissions instead of the shared RPI_PROXY_USER service account.
 *   3. Refresh the token without re-prompting for the password.
 *   4. Discard the token at the end of the session.
 *
 * Run:
 *   bun run packages/mcp-rpi/examples/agent-auth-flow.ts
 *
 * Required env (set in the root .env or your shell):
 *   RPI_INTEGRATION_API_URL   Root URL of the RPI Integration API (no /api/v2 suffix)
 *   RPI_OAUTH_CLIENT_ID       OAuth2 client ID for /connect/token
 *   RPI_OAUTH_CLIENT_SECRET   OAuth2 client secret
 *   RPI_USERNAME              Native RPI username to log in as
 *   RPI_PASSWORD              That user's password
 *
 * Optional env:
 *   MCP_HTTP_URL              MCP server URL (default http://localhost:3002/mcp)
 *
 * The MCP server must be running and reachable at MCP_HTTP_URL. To prove the
 * user token (not the proxy user) is the one being forwarded to RPI, start the
 * MCP server with RPI_PROXY_ENABLED=false — any tool call that fails to forward
 * the user token will then fail loudly instead of silently using the proxy.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface LoginResult {
  accessToken: string;
  /** Present only if the RPI tenant issues refresh tokens. */
  refreshToken?: string;
  /** Token TTL in seconds. */
  expiresIn: number;
}

interface ConnectTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Step 1: Acquire a token for a native RPI user via the OAuth2 password grant.
 * The resulting access_token represents the user's identity — RPI will enforce
 * that user's permissions on every API call made with it.
 */
export async function login(
  rpiBaseUrl: string,
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
): Promise<LoginResult> {
  const url = `${stripTrailingSlash(rpiBaseUrl)}/connect/token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username,
      password,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Login failed: ${response.status} ${response.statusText} — ${await response.text()}`,
    );
  }

  const data = (await response.json()) as ConnectTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Step 3: Exchange a refresh_token for a fresh access_token without re-prompting
 * for the password. Throws if the refresh token is rejected — fall back to a
 * fresh login() in that case.
 */
export async function refresh(
  rpiBaseUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<LoginResult> {
  const url = `${stripTrailingSlash(rpiBaseUrl)}/connect/token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Refresh failed: ${response.status} ${response.statusText} — ${await response.text()}`,
    );
  }

  const data = (await response.json()) as ConnectTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Step 2: Call an MCP tool with the user's access token. The MCP server forwards
 * the token to RPI on every tool-backed API call, so RPI sees the request as
 * coming from the user — not the proxy service account.
 */
export async function callMcpTool(
  mcpUrl: string,
  accessToken: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
  const client = new Client(
    { name: "rpi-agent-auth-example", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return result;
  } finally {
    await client.close();
  }
}

/**
 * Step 4: Logout. RPI does not expose /connect/revoke, so the only meaningful
 * "logout" is a client-side discard. Any in-memory copy of the tokens is
 * cleared; the access token will continue to work against RPI until it expires
 * server-side, so keep token TTLs short if that matters.
 */
export function logout(state: { accessToken?: string; refreshToken?: string }) {
  state.accessToken = undefined;
  state.refreshToken = undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const rpiBaseUrl = requireEnv("RPI_INTEGRATION_API_URL");
  const clientId = requireEnv("RPI_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("RPI_OAUTH_CLIENT_SECRET");
  const username = requireEnv("RPI_USERNAME");
  const password = requireEnv("RPI_PASSWORD");
  const mcpUrl = process.env.MCP_HTTP_URL ?? "http://localhost:3002/mcp";

  // Mutable state so logout() can clear it at the end.
  const state: { accessToken?: string; refreshToken?: string } = {};

  console.log(`[1/5] Logging in as ${username}…`);
  const initial = await login(rpiBaseUrl, clientId, clientSecret, username, password);
  state.accessToken = initial.accessToken;
  state.refreshToken = initial.refreshToken;
  console.log(
    `      access_token: ${preview(state.accessToken!)}, expires_in: ${initial.expiresIn}s, refresh_token: ${state.refreshToken ? "issued" : "(not issued by tenant)"}`,
  );

  console.log(`[2/5] Calling verify_connection on ${mcpUrl}…`);
  const first = await callMcpTool(mcpUrl, state.accessToken!, "verify_connection");
  console.log(`      ${summarize(first)}`);

  if (state.refreshToken) {
    console.log(`[3/5] Refreshing token…`);
    const refreshed = await refresh(
      rpiBaseUrl,
      clientId,
      clientSecret,
      state.refreshToken,
    );
    state.accessToken = refreshed.accessToken;
    state.refreshToken = refreshed.refreshToken ?? state.refreshToken;
    console.log(
      `      new access_token: ${preview(state.accessToken)}, expires_in: ${refreshed.expiresIn}s`,
    );

    console.log(`[4/5] Calling verify_connection again with the refreshed token…`);
    const second = await callMcpTool(mcpUrl, state.accessToken, "verify_connection");
    console.log(`      ${summarize(second)}`);
  } else {
    console.log(`[3/5] Skipping refresh — tenant did not issue a refresh_token.`);
    console.log(`[4/5] (skipped — no refresh to verify)`);
  }

  console.log(`[5/5] Logging out (client-side discard)…`);
  logout(state);
  console.log(
    `      tokens cleared: accessToken=${state.accessToken ?? "undefined"}, refreshToken=${state.refreshToken ?? "undefined"}`,
  );
}

function preview(token: string): string {
  return token.length > 12 ? `${token.slice(0, 8)}…(${token.length} chars)` : token;
}

function summarize(toolResult: unknown): string {
  // verify_connection returns its diagnostic JSON in result.content[0].text.
  const r = toolResult as { content?: Array<{ type: string; text?: string }> };
  const text = r?.content?.[0]?.text;
  if (!text) return JSON.stringify(toolResult).slice(0, 200);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const keys = ["userTokenPresent", "proxyEnabled", "apiCallSuccess"] as const;
    return keys.map((k) => `${k}=${JSON.stringify(parsed[k])}`).join(", ");
  } catch {
    return text.slice(0, 200);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });
}
