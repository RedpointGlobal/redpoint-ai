/**
 * #27895 — verify_connection must not report a false 401 on a multi-tenant
 * instance when no tenant is selected. The connected/auth signal is the
 * CLIENT-AGNOSTIC user-client-list probe; /info/version (tenant-scoped) is
 * secondary — a 401 there with no tenant is "connected, no tenant selected yet",
 * not an auth failure.
 *
 * Register the real tool onto a fake MCP server, back RPIApiClient with a
 * URL-aware mock fetch, invoke the handler, assert the status blob (mirrors the
 * mcp-drh tools.test.ts harness — no live RPI).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import { registerAuthTools } from "../auth.js";

const BASE = "https://rpi.example.test";
const realFetch = globalThis.fetch;

interface Captured {
  handler: (args: any, extra: any) => Promise<{ content: Array<{ text: string }> }>;
}

function fakeServer() {
  const tools = new Map<string, Captured>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Captured["handler"]) {
      tools.set(name, { handler });
    },
  };
  return {
    server: server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    tools,
  };
}

/**
 * Mock fetch keyed by path. `versionStatus` controls the tenant-scoped
 * /info/version response; user-client-list is 200 unless `clientListStatus` says
 * otherwise. /connect/token (proxy) always 200 so proxy checks don't interfere.
 */
function installFetch(opts: { clientListStatus?: number; versionStatus?: number }) {
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/connect/token"))
      return new Response(JSON.stringify({ access_token: "proxy-1", expires_in: 3600 }), { status: 200 });
    if (u.includes("/login-settings") || u.includes("/get-login-settings"))
      return new Response(JSON.stringify([]), { status: 200 });
    if (u.includes("/authentication/user-client-list")) {
      const s = opts.clientListStatus ?? 200;
      return new Response(JSON.stringify(s === 200 ? { clients: [] } : { error: "unauth" }), { status: s });
    }
    if (u.includes("/info/version")) {
      const s = opts.versionStatus ?? 200;
      return new Response(JSON.stringify(s === 200 ? { version: "9.9.9" } : { error: "no tenant" }), { status: s });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function build() {
  const auth = new RPIAuthService(BASE, "cid", "secret"); // no proxy user → proxy disabled
  const client = new RPIApiClient(BASE, auth, "default-client");
  const { server, tools } = fakeServer();
  registerAuthTools(server, client, auth, null);
  return tools.get("verify_connection")!;
}

async function run(args: Record<string, unknown> = {}) {
  const tool = build();
  const res = await tool.handler(args, { authInfo: { token: "user-tok" } });
  return JSON.parse(res.content[0].text) as Record<string, any>;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("verify_connection (#27895)", () => {
  it("multi-tenant, NO tenant selected: client-list 200 + version 401 → connected, NOT a failure", async () => {
    installFetch({ clientListStatus: 200, versionStatus: 401 });
    const r = await run(); // no clientId
    expect(r.connected).toBe(true);
    expect(r.apiCallSuccess).toBe(true); // back-compat alias
    expect(r.tenantSelected).toBe(false);
    expect(String(r.tenantNote)).toMatch(/no tenant selected/i);
    // Softened copy: frames it as NOT an auth problem (may say "do not re-authenticate").
    expect(String(r.tenantNote).toLowerCase()).toContain("not an authentication problem");
    expect(r.connectionError).toBeUndefined();
  });

  it("tenant selected: client-list 200 + version 200 (with clientId) → connected + version", async () => {
    installFetch({ clientListStatus: 200, versionStatus: 200 });
    const r = await run({ clientId: "some-tenant" });
    expect(r.connected).toBe(true);
    expect(r.tenantSelected).toBe(true);
    expect(r.version).toEqual({ version: "9.9.9" });
  });

  it("real auth failure: client-list 401 → connected false + error (the genuine bad case)", async () => {
    installFetch({ clientListStatus: 401 });
    const r = await run();
    expect(r.connected).toBe(false);
    expect(r.apiCallSuccess).toBe(false);
    expect(r.connectionError).toBeDefined();
    // version probe is skipped when not connected
    expect(r.tenantSelected).toBeUndefined();
  });

  it("always reports userTokenPresent from the auth context", async () => {
    installFetch({});
    const r = await run();
    expect(r.userTokenPresent).toBe(true);
  });
});
