/**
 * A turn's per-request MCP sessions end with the turn.
 *
 * With a signed-in user, getToolsForWorkspace opens a FRESH (ephemeral) client per
 * request, carrying the user's Bearer. The RPI MCP server (packages/mcp-rpi) binds each session
 * to its caller and caps each user's open sessions (20 in token mode), so a session
 * left to the server's idle expiry holds a slot: a busy user would run out. The
 * manager's release(tools) closes the turn's ephemeral clients, and the transport's
 * close() ends each session on the server (DELETE with the session id).
 *
 * The stand-in server is the SDK's own Streamable HTTP transport, as the RPI MCP
 * server uses it: one McpServer per session, the session closed on DELETE, and a
 * cap of CAP open sessions per Bearer (a new one past it is refused, like the
 * RPI MCP server's per-user cap).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCPClientManager } from "../mcp/client.js";
import { createPatchedTransport } from "../mcp/patched-transport.js";

const CAP = 2;

/** Open sessions per Bearer; every DELETE seen (session id + Bearer). */
const open = new Map<string, Set<string>>();
const deletes: Array<{ sessionId: string | null; auth: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;
let url: string;
/** A port nothing listens on (a server started, then stopped). */
let gonePort: number;

beforeAll(() => {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      // A connection that always fails (an MCP server answering 500).
      if (new URL(req.url).pathname === "/broken") return new Response("down", { status: 500 });
      const auth = req.headers.get("authorization") ?? "anonymous";
      const sessionId = req.headers.get("mcp-session-id");
      if (req.method === "DELETE") deletes.push({ sessionId, auth: req.headers.get("authorization") });
      if (sessionId) {
        const existing = sessions.get(sessionId);
        return existing ? existing.handleRequest(req) : Response.json({ error: "Session not found" }, { status: 404 });
      }
      const mine = open.get(auth) ?? new Set<string>();
      open.set(auth, mine);
      if (mine.size >= CAP) return Response.json({ error: "too many open sessions" }, { status: 429 });
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          mine.add(id);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          mine.delete(id);
        },
      });
      const mcp = new McpServer({ name: "stand-in", version: "0" });
      mcp.registerTool("ping", { description: "ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });
  url = `http://127.0.0.1:${server.port}/mcp`;
  const gone = Bun.serve({ port: 0, fetch: () => new Response() });
  gonePort = gone.port;
  gone.stop(true);
});

afterAll(() => server.stop(true));

beforeEach(() => {
  open.clear();
  deletes.length = 0;
});

const conn = () => [{ name: "rpi", transport: "http" as const, url }];
const openFor = (token: string) => open.get(`Bearer ${token}`)?.size ?? 0;

describe("release(tools) ends the turn's per-request MCP sessions", () => {
  it("a released turn leaves no session open on the server, and the DELETE carries the user's Bearer", async () => {
    const manager = new MCPClientManager();
    const tools = await manager.getToolsForWorkspace("ws", conn(), "tok-a");
    expect(Object.keys(tools)).toEqual(["rpi__ping"]);
    expect(openFor("tok-a")).toBe(1);

    await manager.release(tools);
    expect(openFor("tok-a")).toBe(0);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.sessionId).toBeTruthy();
    expect(deletes[0]!.auth).toBe("Bearer tok-a");
  });

  it("a busy user: more turns than the server's per-user cap all succeed when each is released", async () => {
    const manager = new MCPClientManager();
    for (let turn = 0; turn < CAP * 3; turn++) {
      const tools = await manager.getToolsForWorkspace("ws", conn(), "tok-busy");
      expect(Object.keys(tools)).toEqual(["rpi__ping"]);
      await manager.release(tools);
    }
    expect(openFor("tok-busy")).toBe(0);
  });

  it("the contrast: unreleased turns hold their sessions and the user hits the cap", async () => {
    const manager = new MCPClientManager();
    for (let turn = 0; turn < CAP; turn++) await manager.getToolsForWorkspace("ws", conn(), "tok-leak");
    expect(openFor("tok-leak")).toBe(CAP);
    await expect(manager.getToolsForWorkspace("ws", conn(), "tok-leak")).rejects.toThrow();
  });

  it("release is idempotent, and a no-token (cached, shared) tools object is left alone", async () => {
    const manager = new MCPClientManager();
    const ephemeral = await manager.getToolsForWorkspace("ws", conn(), "tok-b");
    await manager.release(ephemeral);
    await manager.release(ephemeral);
    expect(deletes).toHaveLength(1);

    const shared = await manager.getToolsForWorkspace("ws-shared", conn());
    await manager.release(shared);
    expect(deletes).toHaveLength(1);
    // The shared client keeps its session (it is reused across requests).
    expect(open.get("anonymous")?.size).toBe(1);
    await manager.closeAll();
  });

  it("a request whose later connection fails ends the sessions it already opened", async () => {
    const manager = new MCPClientManager();
    const dead = { name: "drh", transport: "http" as const, url: url.replace(/\/mcp$/, "/broken") };
    await expect(manager.getToolsForWorkspace("ws", [...conn(), dead], "tok-c")).rejects.toThrow();
    expect(openFor("tok-c")).toBe(0);
    expect(deletes.map((d) => d.auth)).toContain("Bearer tok-c");
  });
});

describe("the transport's close() ends its session on the server", () => {
  it("no session yet → no request at all", async () => {
    const before = deletes.length;
    await createPatchedTransport({ url }).close();
    expect(deletes.length).toBe(before);
  });

  it("a server that is gone → close still resolves (best effort)", async () => {
    const transport = createPatchedTransport({ url: `http://127.0.0.1:${gonePort}/mcp` });
    transport.sessionId = "s-1";
    await transport.close();
    expect(transport.sessionId).toBeNull();
  });
});
