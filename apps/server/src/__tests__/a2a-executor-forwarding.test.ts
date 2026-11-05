/**
 * A2A executor forwards the verified caller's token to the MCP tools — the same
 * per-user path the web chat uses (getToolsForWorkspace's 3rd argument) — and in
 * oidc mode refuses to run tools without a verified user (never the service
 * account). Plus the boot check that every MCP of the A2A workspace enforces
 * per-user auth.
 *
 * HERMETIC (mirrors rpi-forward-context.test.ts): own in-memory testDb + a stub
 * mcpManager recording getToolsForWorkspace args, mock.module'd BEFORE the
 * executor is imported. Tools are resolved before any model call, so no LLM runs.
 */
import { describe, it, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import { UnauthenticatedUser, ServerCallContext } from "@a2a-js/sdk/server";
import * as schema from "../store/schema.js";
import { A2AVerifiedUser, checkPerUserMcp, forwardedTokenOf } from "../a2a/auth.js";

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
// This file sorts before auth-middleware.test.ts, and bun's module mocks are
// process-wide: middleware/auth.ts then loads against THIS db. So the mocked db
// must also hold the tables its other readers query — api_keys, exactly as
// store/schema.ts defines it (an unknown key must still read as "no row").
testDb.run(sql`
  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    key_hash     TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    name         TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id),
    permissions  TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER,
    last_used_at INTEGER
  )
`);
mock.module("../store/db.js", () => ({ db: testDb }));

const toolCalls: unknown[][] = [];
// Each call returns its own tools object; release() records what it was handed.
const loaded: object[] = [];
const released: object[] = [];
mock.module("../mcp/client.js", () => ({
  mcpManager: {
    getToolsForWorkspace: (...args: unknown[]) => {
      toolCalls.push(args);
      const tools = {};
      loaded.push(tools);
      return Promise.resolve(tools);
    },
    release: async (tools: object) => {
      released.push(tools);
    },
    getTransport: () => undefined,
    closeWorkspace: async () => {},
    closeAll: async () => {},
  },
  MCPClientManager: class {},
}));

const { WorkspaceExecutor } = await import("../a2a/executor.js");
const { SkillRegistry } = await import("@redpoint-ai/skills");

const WS_ID = "22222222-2222-2222-2222-222222222222";
const MCP = [{ name: "rpi", transport: "http", url: "http://localhost:3002/mcp" }];
testDb
  .insert(schema.workspaces)
  .values({
    id: WS_ID,
    name: "A2A forwarding WS",
    description: null,
    config: JSON.stringify({ provider: { type: "anthropic", model: "claude-opus-4-5" }, mcp: MCP }),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  .run();

function run(authMode: "bearer" | "oidc", user?: unknown) {
  toolCalls.length = 0;
  const published: Array<{ parts: Array<{ text?: string }> }> = [];
  const executor = new WorkspaceExecutor({ workspaceId: WS_ID, skillRegistry: new SkillRegistry(), authMode });
  const requestContext = {
    userMessage: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text: "hi" }] },
    taskId: "t1",
    contextId: "c1",
    context: user === undefined ? undefined : new ServerCallContext(undefined, user as never),
  } as never;
  const eventBus = { publish: (e: never) => published.push(e), finished: () => {} } as never;
  return executor.execute(requestContext, eventBus).then(() => ({ published }));
}

describe("forwardedTokenOf", () => {
  it("a verified user → their token; unauthenticated / no context → undefined", () => {
    expect(forwardedTokenOf({ context: new ServerCallContext(undefined, new A2AVerifiedUser("u1", "alice", "tok-alice")) })).toBe("tok-alice");
    expect(forwardedTokenOf({ context: new ServerCallContext(undefined, new UnauthenticatedUser()) })).toBeUndefined();
    expect(forwardedTokenOf({ context: undefined })).toBeUndefined();
  });
});

describe("WorkspaceExecutor — per-user tools", () => {
  it("oidc + a verified user → getToolsForWorkspace(ws, mcp, <their token>)", async () => {
    await run("oidc", new A2AVerifiedUser("u1", "alice", "tok-alice"));
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]![0]).toBe(WS_ID);
    expect(toolCalls[0]![1]).toEqual(MCP);
    expect(toolCalls[0]![2]).toBe("tok-alice");
    // No per-request instance URL or tenant on A2A → the MCP's defaults.
    expect(toolCalls[0]![3]).toBeUndefined();
    expect(toolCalls[0]![4]).toBeUndefined();
  });

  it("the turn's per-request MCP sessions end with it: the loaded tools are released", async () => {
    loaded.length = 0;
    released.length = 0;
    await run("oidc", new A2AVerifiedUser("u1", "alice", "tok-alice"));
    expect(loaded).toHaveLength(1);
    expect(released).toContain(loaded[0]!);
  });

  it("oidc without a verified user → refuses, NO tool call, an error message is published", async () => {
    for (const user of [new UnauthenticatedUser(), undefined]) {
      const { published } = await run("oidc", user);
      expect(toolCalls).toHaveLength(0);
      expect(published[0]!.parts[0]!.text).toBe(
        "Error: no verified user on this request — refusing to run tools as the service account",
      );
    }
  });

  it("bearer → tools resolved with no user token (the proxy path, as before)", async () => {
    await run("bearer", new UnauthenticatedUser());
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]![2]).toBeUndefined();
  });
});

describe("checkPerUserMcp — every MCP must enforce per-user auth (boot, oidc)", () => {
  const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
  it("an MCP that answers an unauthenticated request with 401 → ok", async () => {
    expect(await checkPerUserMcp(MCP, { fetchImpl: status(401) })).toEqual({ ok: true });
  });
  it("an MCP that ACCEPTS an unauthenticated request (e.g. AUTH_REQUIRED=false) → error", async () => {
    const r = await checkPerUserMcp(MCP, { fetchImpl: status(200) });
    expect("error" in r && r.error).toBe(
      'A2A_AUTH_MODE=oidc but MCP "rpi" accepted a request with no token (HTTP 200) — it would ignore forwarded user tokens and run as its service account (for mcp-rpi: set AUTH_REQUIRED=true)',
    );
  });
  it("a stdio MCP → error (tokens can't be forwarded to it)", async () => {
    const r = await checkPerUserMcp([{ name: "local", transport: "stdio" }], { fetchImpl: status(401) });
    expect("error" in r && r.error).toContain('MCP "local" is not an http connection');
  });
  it("an unreachable MCP → error after the bounded retries", async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await checkPerUserMcp(MCP, { fetchImpl: down, attempts: 3, delayMs: 1 });
    expect(calls).toBe(3);
    expect("error" in r && r.error).toContain("could not be reached to confirm it enforces per-user auth");
  });
  it("no MCP connection → error", async () => {
    expect("error" in (await checkPerUserMcp([]))).toBe(true);
  });
  it("every connection is checked — one open MCP among several fails the whole check", async () => {
    let n = 0;
    const mixed = (async () => new Response("{}", { status: n++ === 0 ? 401 : 200 })) as unknown as typeof fetch;
    const r = await checkPerUserMcp([...MCP, { name: "drh", transport: "http", url: "http://localhost:3003/mcp" }], { fetchImpl: mixed });
    expect("error" in r && r.error).toContain('MCP "drh" accepted a request with no token');
  });
});
