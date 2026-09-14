/**
 * Panel-401 fix (#27828 follow-up) — the per-request RPI forwarding context.
 *
 * Bug: the info-panel showed MCP "rpi" unreachable (401) whenever a user was on a
 * NON-default Environment Location, because the runtime-status / tools handlers
 * read x-rpi-token but NOT x-rpi-url → the probe validated the token against the
 * DEFAULT instance. Fix: one shared reader (readRpiForwardContext) both the chat
 * route and the workspaces handlers use, so the SAME (token, url) pair is threaded
 * everywhere and no route can read one header but forget the other.
 *
 * HERMETIC (mirrors workspaces.test.ts): own in-memory testDb + a stub mcpManager
 * that records getToolsForWorkspace args, mock.module'd BEFORE workspaceRoutes is
 * imported. readRpiForwardContext is the REAL helper (not mocked).
 */
import { describe, it, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "../store/schema.js";
import { readRpiForwardContext } from "../mcp/forward-headers.js";

// ---------------------------------------------------------------------------
// Pure unit tests of the shared reader — the choke point that reads BOTH headers.
// ---------------------------------------------------------------------------
describe("readRpiForwardContext", () => {
  const ctx = (headers: Record<string, string>) => ({
    req: { header: (n: string) => headers[n] },
  });

  it("reads BOTH x-rpi-token and x-rpi-url (the pair travels together)", () => {
    const r = readRpiForwardContext(
      ctx({ "x-rpi-token": "tok123", "x-rpi-url": "https://loc.example.com" }),
    );
    expect(r).toEqual({ userRpiToken: "tok123", userRpiUrl: "https://loc.example.com" });
  });

  it("x-rpi-url present without... it's still read (the exact bug: url must not be dropped)", () => {
    const r = readRpiForwardContext(ctx({ "x-rpi-url": "https://loc.example.com" }));
    expect(r.userRpiUrl).toBe("https://loc.example.com");
    expect(r.userRpiToken).toBeUndefined();
  });

  it("neither header → both undefined (default-instance path)", () => {
    expect(readRpiForwardContext(ctx({}))).toEqual({
      userRpiToken: undefined,
      userRpiUrl: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Handler-level: the tools + runtime-status endpoints thread x-rpi-url into
// getToolsForWorkspace. Stub mcpManager records the args.
// ---------------------------------------------------------------------------
const sqlite = new Database(":memory:");
const testDb = drizzle(sqlite, { schema });
testDb.run(sql`
  CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    config      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`);
mock.module("../store/db.js", () => ({ db: testDb }));

// Record every getToolsForWorkspace call's args; return an empty tool set.
const toolCalls: unknown[][] = [];
const stubMcpManager = {
  getToolsForWorkspace: (...args: unknown[]) => {
    toolCalls.push(args);
    return Promise.resolve({});
  },
  getTransport: () => undefined,
  closeWorkspace: async () => {},
  closeAll: async () => {},
};
mock.module("../mcp/client.js", () => ({
  mcpManager: stubMcpManager,
  MCPClientManager: class {},
}));

process.env.AUTH_REQUIRED = "false";

const { workspaceRoutes } = await import("../routes/workspaces.js");
const { Hono } = await import("hono");
const app = new Hono();
app.route("/workspaces", workspaceRoutes);

const WS_ID = "11111111-1111-1111-1111-111111111111";
testDb
  .insert(schema.workspaces)
  .values({
    id: WS_ID,
    name: "Forward Ctx WS",
    description: null,
    config: JSON.stringify({
      provider: { type: "anthropic", model: "claude-opus-4-5" },
      mcp: [{ name: "rpi", transport: "http", url: "http://localhost:3002/mcp" }],
    }),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  .run();

const LOC = "https://loc-a.example.com";

/** getToolsForWorkspace(workspaceId, mcp, userRpiToken, userRpiUrl, …) → url is index 3. */
function urlArgsSeen(): (string | undefined)[] {
  return toolCalls.map((a) => a[3] as string | undefined);
}

describe("runtime-status / tools handlers thread x-rpi-url into getToolsForWorkspace", () => {
  it("GET /tools with X-RPI-URL → threaded as the 4th arg (was dropped → panel 401)", async () => {
    toolCalls.length = 0;
    const res = await app.request(`http://localhost/workspaces/${WS_ID}/tools`, {
      headers: { "X-RPI-Token": "tokA", "X-RPI-URL": LOC },
    });
    expect(res.status).toBe(200);
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(urlArgsSeen()).toContain(LOC);
  });

  it("GET /runtime-status with X-RPI-URL → threaded (probe targets the rep's instance)", async () => {
    toolCalls.length = 0;
    const res = await app.request(
      `http://localhost/workspaces/${WS_ID}/runtime-status`,
      { headers: { "X-RPI-Token": "tokB", "X-RPI-URL": "https://loc-b.example.com" } },
    );
    expect(res.status).toBe(200);
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(urlArgsSeen()).toContain("https://loc-b.example.com");
  });

  it("no X-RPI-URL → 4th arg undefined (default instance, backward-compat)", async () => {
    toolCalls.length = 0;
    const res = await app.request(`http://localhost/workspaces/${WS_ID}/tools`, {
      headers: { "X-RPI-Token": "tokC" },
    });
    expect(res.status).toBe(200);
    expect(urlArgsSeen().every((u) => u === undefined)).toBe(true);
  });
});
