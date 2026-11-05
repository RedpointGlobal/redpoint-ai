/**
 * The caller's RPI identity goes to the RPI MCP connection ONLY.
 *
 * A workspace's tools are loaded per request with the caller's RPI token and their
 * RPI tenant. The RPI connection (RPI_CONNECTION, "rpi") gets both: the token as the
 * Bearer, the tenant injected as every tool call's `clientId`. Any other connection —
 * the DRH MCP server, a user-configured one — gets NEITHER: the DRH server reads a
 * per-call `clientId` as its own tenant, so an injected RPI tenant would send DRH
 * calls to the wrong tenant (and leak the RPI tenant across products); without one
 * it uses its own default (DRH_DEFAULT_CLIENT_ID). It runs on the shared client.
 *
 * Two stand-in MCP servers (the SDK's own Streamable HTTP transport) record every
 * request's Authorization header and every tool call's arguments.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { MCPClientManager, RPI_CONNECTION } from "../mcp/client.js";

const auth: Record<string, Array<string | null>> = { rpi: [], drh: [], other: [] };
const calls: Record<string, Array<Record<string, unknown>>> = { rpi: [], drh: [], other: [] };
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const name = new URL(req.url).pathname.slice(1); // /rpi | /drh | /other
      auth[name]!.push(req.headers.get("authorization"));
      const sid = req.headers.get("mcp-session-id");
      if (sid) {
        const t = sessions.get(sid);
        return t ? t.handleRequest(req) : new Response("gone", { status: 404 });
      }
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => void sessions.set(id, transport),
      });
      const mcp = new McpServer({ name, version: "0" });
      mcp.registerTool("whoami", { description: "echo", inputSchema: { clientId: z.string().optional(), q: z.string().optional() } }, async (args) => {
        calls[name]!.push({ ...args });
        return { content: [{ type: "text", text: "ok" }] };
      });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  for (const k of Object.keys(auth)) {
    auth[k] = [];
    calls[k] = [];
  }
});

const conns = () => [
  { name: RPI_CONNECTION, transport: "http" as const, url: `${base}/rpi` },
  { name: "drh", transport: "http" as const, url: `${base}/drh` },
  { name: "other", transport: "http" as const, url: `${base}/other` },
];
const call = (tools: Record<string, any>, name: string, args: Record<string, unknown> = {}) =>
  tools[name].execute(args, { toolCallId: "t", messages: [] });

describe("the caller's RPI identity goes to the RPI connection only", () => {
  it("a signed-in turn: the RPI call carries the user's Bearer and the RPI tenant; DRH and others carry neither", async () => {
    const manager = new MCPClientManager();
    const tools = await manager.getToolsForWorkspace("ws", conns(), "tok-user", undefined, "rpi-tenant-1");
    await call(tools, "rpi__whoami", { q: "a" });
    await call(tools, "drh__whoami", { q: "b" });
    await call(tools, "other__whoami", { q: "c" });

    expect(calls.rpi).toEqual([{ q: "a", clientId: "rpi-tenant-1" }]);
    expect(calls.drh).toEqual([{ q: "b" }]);
    expect(calls.other).toEqual([{ q: "c" }]);

    expect(new Set(auth.rpi)).toEqual(new Set(["Bearer tok-user"]));
    expect(auth.drh.every((a) => a === null)).toBe(true);
    expect(auth.other.every((a) => a === null)).toBe(true);
    await manager.release(tools);
    await manager.closeAll();
  });

  it("the deployment default tenant (RPI_DEFAULT_CLIENT_ID) is injected for RPI only, never into a DRH call", async () => {
    const saved = process.env.RPI_DEFAULT_CLIENT_ID;
    process.env.RPI_DEFAULT_CLIENT_ID = "rpi-default";
    try {
      const manager = new MCPClientManager();
      const tools = await manager.getToolsForWorkspace("ws2", conns());
      await call(tools, "rpi__whoami");
      await call(tools, "drh__whoami");
      expect(calls.rpi).toEqual([{ clientId: "rpi-default" }]);
      expect(calls.drh).toEqual([{}]);
      await manager.closeAll();
    } finally {
      if (saved === undefined) delete process.env.RPI_DEFAULT_CLIENT_ID;
      else process.env.RPI_DEFAULT_CLIENT_ID = saved;
    }
  });

  it("a DRH call keeps a tenant the model set itself (the DRH tenant); only the RPI call is overridden", async () => {
    const manager = new MCPClientManager();
    const tools = await manager.getToolsForWorkspace("ws3", conns(), "tok-user", undefined, "rpi-tenant-1");
    await call(tools, "drh__whoami", { clientId: "drh-tenant-x" });
    await call(tools, "rpi__whoami", { clientId: "something-else" });
    expect(calls.drh).toEqual([{ clientId: "drh-tenant-x" }]);
    expect(calls.rpi).toEqual([{ clientId: "rpi-tenant-1" }]);
    await manager.release(tools);
    await manager.closeAll();
  });
});
