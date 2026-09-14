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
import {
  configureInstrumentation,
  type InstrumentationEvent,
  type InstrumentationSink,
} from "@redpoint-ai/shared";

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
  currentDatePreamble: (now: Date = new Date()) => `Current date: ${now.toISOString()} (UTC).`,
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

  // Regression: the parent turn's usage is populated only in onStepFinish, NOT in
  // createAgentUIStreamResponse's onFinish event (which carries no usage). This
  // codifies the side-effects that were silently dead — a runs row AND a parent
  // instrumentation event must fire from the accumulated per-step usage.
  it("writes a runs row and emits a parent instrumentation event from accumulated per-step usage", async () => {
    const wsId = randomUUID();
    await insertWorkspace(wsId);

    class RecordingSink implements InstrumentationSink {
      events: InstrumentationEvent[] = [];
      write(e: InstrumentationEvent) {
        this.events.push(e);
      }
    }
    const sink = new RecordingSink();
    configureInstrumentation(sink);
    const savedEnvId = process.env.INSTRUMENTATION_USER_ID;
    process.env.INSTRUMENTATION_USER_ID = "regression-tester";

    // Drive the stream: one usage-bearing step, then finish (onFinish has no usage).
    mockCreateAgentUIStreamResponse.mockImplementationOnce(async (opts: any) => {
      opts.onStepFinish({
        text: "hi",
        toolCalls: [],
        // One execute_skill result carrying the sub-agent's own usage (as
        // router.ts returns it) → should emit a role:"sub-agent" event.
        toolResults: [
          {
            toolName: "execute_skill",
            output: {
              skillName: "rpi-audiences",
              usage: {
                inputTokens: 200,
                outputTokens: 50,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                totalTokens: 250,
              },
            },
          },
        ],
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 },
          outputTokenDetails: { reasoningTokens: 12 },
        },
      });
      await opts.onFinish({});
      return new Response("ok");
    });

    try {
      const res = await app.request(url(`/api/v1/workspaces/${wsId}/chat`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "idem-regression-1",
        },
        body: JSON.stringify({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] },
          ],
        }),
      });
      expect(res.status).toBe(200);

      // (a) runs row written from the accumulated usage (was silently skipped before)
      const rows = sqlite
        .query(
          "SELECT prompt_tokens, completion_tokens, total_tokens, status FROM runs",
        )
        .all() as Array<{
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        status: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].prompt_tokens).toBe(100);
      expect(rows[0].completion_tokens).toBe(40);
      expect(rows[0].total_tokens).toBe(140);
      expect(rows[0].status).toBe("completed");

      // (b) one parent event + one sub-agent event, sharing the correlation id
      expect(sink.events).toHaveLength(2);
      const parent = sink.events.find((e) => e.role === "parent")!;
      const sub = sink.events.find((e) => e.role === "sub-agent")!;
      expect(parent).toBeDefined();
      expect(sub).toBeDefined();

      // Parent — its OWN accumulated usage (100/40/140), no skillName
      expect(parent.clientId).toBe("web");
      expect(parent.userId).toBe("regression-tester");
      expect(parent.idempotencyKey).toBe("idem-regression-1");
      expect(parent.workspaceId).toBe(wsId);
      expect(parent.provider).toBe("openai");
      expect(parent.model).toBe("gpt-4o");
      expect(parent.inputTokens).toBe(100);
      expect(parent.outputTokens).toBe(40);
      expect(parent.cacheReadTokens).toBe(10);
      expect(parent.cacheWriteTokens).toBe(5);
      expect(parent.reasoningTokens).toBe(12);
      expect(parent.totalTokens).toBe(140);
      expect(parent.skillName).toBeUndefined();
      expect(typeof parent.eventId).toBe("string");
      expect(parent.eventId.length).toBeGreaterThan(0);

      // Sub-agent — the skill's OWN usage (200/50/250) + skillName, NOT summed
      expect(sub.skillName).toBe("rpi-audiences");
      expect(sub.inputTokens).toBe(200);
      expect(sub.outputTokens).toBe(50);
      expect(sub.totalTokens).toBe(250);
      expect(sub.clientId).toBe("web");

      // Correlation — critical for the Step-6 dedup grain: SAME runId + idempotencyKey
      expect(sub.runId).toBe(parent.runId);
      expect(sub.idempotencyKey).toBe(parent.idempotencyKey);
      expect(sub.userId).toBe(parent.userId);
      // Distinct event ids
      expect(sub.eventId).not.toBe(parent.eventId);
    } finally {
      configureInstrumentation(null);
      if (savedEnvId === undefined) delete process.env.INSTRUMENTATION_USER_ID;
      else process.env.INSTRUMENTATION_USER_ID = savedEnvId;
    }
  });
});
