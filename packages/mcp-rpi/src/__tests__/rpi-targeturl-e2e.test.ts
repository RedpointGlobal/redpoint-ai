/**
 * Phase 1a end-to-end: a real tool dispatch with `authInfo.targetUrl` set must
 * route the outbound RPI call to THAT location, and without it to the default.
 *
 * This locks the whole thread through a real handler: the tool-registration
 * choke point (tool-categories) preserves authInfo.targetUrl while injecting the
 * resolved token → the handler reads it via targetUrlOf(extra) → passes it as
 * RequestOptions.baseUrl → the client hits that base. If any link drops it, the
 * default leaks — the wrong-location bug this feature prevents.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";
import { registerClientTools } from "../tools/clients.js";

const DEFAULT = "https://default.example.test";
const LOC_A = "https://loc-a.example.com";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function buildServer() {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  const auth = new RPIAuthService(DEFAULT, "id", "secret", "proxy", "proxy-pass");
  registerClientTools(server, new RPIApiClient(DEFAULT, auth, "tenant-default"));
  return server;
}

function dispatch(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  authInfo: Record<string, unknown>,
) {
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  return handlers.get("tools/call")!(
    { method: "tools/call", params: { name, arguments: args } },
    {
      signal: new AbortController().signal,
      sendRequest: () => Promise.resolve({}),
      authInfo,
    },
  );
}

describe("Phase 1a e2e — authInfo.targetUrl routes a real tool dispatch", () => {
  it("dispatch WITH targetUrl hits that location; WITHOUT it hits the default", async () => {
    let url = "";
    globalThis.fetch = mock(async (u: string | URL) => {
      url = String(u);
      return new Response(JSON.stringify({ clients: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const server = buildServer();

    await dispatch(
      server,
      "list_clients",
      { pageNumber: 1, pageSize: 20 },
      { token: "tok", clientId: "x", scopes: [], targetUrl: LOC_A },
    );
    expect(url.startsWith(`${LOC_A}/api/v2/`)).toBe(true);

    await dispatch(
      server,
      "list_clients",
      { pageNumber: 1, pageSize: 20 },
      { token: "tok", clientId: "x", scopes: [] },
    );
    expect(url.startsWith(`${DEFAULT}/api/v2/`)).toBe(true);
  });
});
