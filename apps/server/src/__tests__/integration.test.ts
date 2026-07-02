/**
 * Integration tests for the chat endpoint wiring.
 *
 * Strategy: mock heavy dependencies (AI SDK, skills, MCP) and use an
 * in-memory SQLite DB to test that the route handler properly validates
 * requests and dispatches to the agent.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "../store/schema.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// In-memory database — same pattern as workspaces.test.ts
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

testDb.run(sql`
  CREATE TABLE IF NOT EXISTS threads (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )
`);

testDb.run(sql`
  CREATE TABLE IF NOT EXISTS runs (
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    error             TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    created_at        INTEGER NOT NULL,
    finished_at       INTEGER
  )
`);

testDb.run(sql`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT,
    thread_id    TEXT,
    run_id       TEXT,
    action       TEXT NOT NULL,
    details      TEXT,
    user_id      TEXT,
    created_at   INTEGER NOT NULL
  )
`);

// ---------------------------------------------------------------------------
// Mocks — must be set before importing the module under test
// ---------------------------------------------------------------------------

// DB mock
mock.module("../store/db.js", () => ({ db: testDb }));

// Disable auth
process.env.AUTH_REQUIRED = "false";

// AI SDK mock
const mockCreateAgentUIStreamResponse = mock((_opts: any) => {
  return new Response(JSON.stringify({ status: "streaming" }), {
    headers: { "Content-Type": "application/json" },
  });
});

mock.module("ai", () => {
  const actual = require("ai");
  return {
    ...actual,
    createAgentUIStreamResponse: mockCreateAgentUIStreamResponse,
    ToolLoopAgent: class {
      constructor(_opts: any) {}
    },
    stepCountIs: (n: number) => n,
  };
});

// Skills mock
mock.module("@redpoint-ai/skills", () => ({
  SkillRegistry: class {
    list() { return []; }
    register() {}
    buildCatalog() { return "No skills available."; }
  },
  loadSkillsFromDirectory: () => Promise.resolve([]),
  createSkillRouterTool: () => ({}),
  buildRouterSystemPrompt: (base: string, _catalog: string) => base,
  // Faithful to the real predicate so server imports resolve.
  isDispatchable: (s: { type: string; dispatch?: boolean }) =>
    s.type !== "expert" || s.dispatch === true,
  isInlinedExpert: (s: { type: string; dispatch?: boolean }) =>
    s.type === "expert" && s.dispatch !== true,
}));

// MCP client mock
mock.module("../mcp/client.js", () => ({
  mcpManager: {
    getToolsForWorkspace: mock(() => Promise.resolve({})),
    closeAll: mock(() => Promise.resolve()),
  },
}));

// Provider mock — prevent real SDK imports. Exports must mirror the real
// providers.ts surface; if you add an export there, add it here too. (Bun's
// mock.module is process-global and these mocks leak to other test files.)
mock.module("../config/providers.js", () => ({
  createModelFromConfig: (_config: any) => ({
    specificationVersion: "v1",
    provider: "mock",
    modelId: "mock-model",
  }),
  listProviders: () => [],
}));

// Agent mock
mock.module("../agents/orchestrator.js", () => ({
  createWorkspaceAgent: (_config: any) => ({
    model: {},
    system: "test",
    tools: {},
  }),
}));

// Logger mock
mock.module("../lib/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Audit mock
mock.module("../lib/audit.js", () => ({
  logAudit: mock(() => Promise.resolve()),
}));

// Metrics mock
mock.module("../routes/metrics.js", () => ({
  runsTotal: { inc: () => {} },
  tokensTotal: { inc: () => {} },
  runDuration: { observe: () => {} },
  activeSessions: { inc: () => {}, dec: () => {} },
  hallucinationsTotal: { inc: () => {} },
}));

// ---------------------------------------------------------------------------
// Import the routes AFTER mocks are set up
// ---------------------------------------------------------------------------

const { chatRoutes } = await import("../routes/chat.js");

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);
app.route("/api/v1/workspaces", chatRoutes);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function url(path: string) {
  return `${BASE}${path}`;
}

async function insertWorkspace(id: string) {
  const config = JSON.stringify({
    provider: { type: "openai", model: "gpt-4o" },
  });
  const now = Date.now();
  testDb.run(
    sql`INSERT INTO workspaces (id, name, description, config, created_at, updated_at)
        VALUES (${id}, 'Test Workspace', 'test', ${config}, ${now}, ${now})`,
  );
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDb.run(sql`DELETE FROM workspaces`);
  testDb.run(sql`DELETE FROM runs`);
  testDb.run(sql`DELETE FROM audit_logs`);
  mockCreateAgentUIStreamResponse.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/workspaces/:workspaceId/chat", () => {
  it("returns 404 for an unknown workspace", async () => {
    const res = await app.request(
      url("/api/v1/workspaces/00000000-0000-0000-0000-000000000000/chat"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
        }),
      },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("returns 400 when messages array is missing", async () => {
    const wsId = randomUUID();
    await insertWorkspace(wsId);

    const res = await app.request(
      url(`/api/v1/workspaces/${wsId}/chat`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("messages");
  });

  it("returns 400 when messages is not an array", async () => {
    const wsId = randomUUID();
    await insertWorkspace(wsId);

    const res = await app.request(
      url(`/api/v1/workspaces/${wsId}/chat`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: "not-an-array" }),
      },
    );

    expect(res.status).toBe(400);
  });

  it("calls createAgentUIStreamResponse with valid workspace and messages", async () => {
    const wsId = randomUUID();
    await insertWorkspace(wsId);

    const res = await app.request(
      url(`/api/v1/workspaces/${wsId}/chat`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              id: "msg-1",
              role: "user",
              parts: [{ type: "text", text: "Hello" }],
            },
          ],
        }),
      },
    );

    // The mock returns a 200 JSON response
    expect(res.status).toBe(200);
    expect(mockCreateAgentUIStreamResponse).toHaveBeenCalledTimes(1);
  });
});
