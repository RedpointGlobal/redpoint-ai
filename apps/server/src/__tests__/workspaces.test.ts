/**
 * Integration tests for the workspace CRUD routes.
 *
 * Strategy: use Bun's mock.module() to replace the `db` singleton with an
 * in-memory SQLite/Drizzle instance so tests are fully isolated from the
 * filesystem database and from each other.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "../store/schema.js";

// ---------------------------------------------------------------------------
// Build an in-memory database and create tables before any module is loaded.
// mock.module() must be called before the module under test is imported.
// ---------------------------------------------------------------------------

const sqlite = new Database(":memory:");
const testDb = drizzle(sqlite, { schema });

// Create all tables that workspaceRoutes depends on.
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

// Replace the db module before workspaceRoutes is imported.
mock.module("../store/db.js", () => ({ db: testDb }));

// Also disable auth middleware so protected routes are exercised directly.
process.env.AUTH_REQUIRED = "false";

// Now import the routes (module cache will use our mocked db).
const { workspaceRoutes } = await import("../routes/workspaces.js");

// Wrap routes in a minimal Hono app for request testing.
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);
app.route("/workspaces", workspaceRoutes);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function url(path: string) {
  return `${BASE}${path}`;
}

const validProviderPayload = {
  type: "anthropic",
  model: "claude-opus-4-5",
  apiKey: "sk-ant-test-key",
};

async function createWorkspace(name = "Test Workspace") {
  const res = await app.request(
    url("/workspaces"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: "Integration test workspace",
        provider: validProviderPayload,
      }),
    },
  );
  return res;
}

// ---------------------------------------------------------------------------
// Reset table between tests for isolation.
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDb.run(sql`DELETE FROM workspaces`);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /workspaces", () => {
  it("returns an empty array when no workspaces exist", async () => {
    const res = await app.request(url("/workspaces"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it("returns all created workspaces", async () => {
    await createWorkspace("Workspace Alpha");
    await createWorkspace("Workspace Beta");

    const res = await app.request(url("/workspaces"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    const names = body.map((w: { name: string }) => w.name);
    expect(names).toContain("Workspace Alpha");
    expect(names).toContain("Workspace Beta");
  });
});

describe("POST /workspaces", () => {
  it("creates a workspace and returns 201 with the new record", async () => {
    const res = await createWorkspace("My New Workspace");
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.id).toBeString();
    expect(body.name).toBe("My New Workspace");
    expect(body.description).toBe("Integration test workspace");
    // config is serialized JSON stored in the db row
    expect(body.config).toBeString();
    const config = JSON.parse(body.config);
    expect(config.provider.type).toBe("anthropic");
  });

  it("returns 400 when 'name' is missing", async () => {
    const res = await app.request(url("/workspaces"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: validProviderPayload }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when provider type is invalid", async () => {
    const res = await app.request(url("/workspaces"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Workspace",
        provider: { type: "invalid-provider", model: "some-model" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("stores optional mcp and skills config in the JSON config column", async () => {
    const res = await app.request(url("/workspaces"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Full Config",
        provider: validProviderPayload,
        mcp: [{ name: "rpi", transport: "http", url: "https://mcp.test" }],
        skills: ["market-research"],
        suggestions: ["Analyze top campaigns"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const config = JSON.parse(body.config);
    expect(config.mcp).toHaveLength(1);
    expect(config.mcp[0].name).toBe("rpi");
    expect(config.skills).toEqual(["market-research"]);
    expect(config.suggestions).toEqual(["Analyze top campaigns"]);
  });
});

describe("GET /workspaces/:id", () => {
  it("returns the workspace when found", async () => {
    const created = await (await createWorkspace()).json();
    const res = await app.request(url(`/workspaces/${created.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("Test Workspace");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.request(
      url("/workspaces/00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

describe("PUT /workspaces/:id", () => {
  it("updates an existing workspace and returns the updated record", async () => {
    const created = await (await createWorkspace()).json();

    const res = await app.request(url(`/workspaces/${created.id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated Name",
        description: "Updated description",
        provider: { type: "openai", model: "gpt-4o" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("Updated Name");
    expect(body.description).toBe("Updated description");
    const config = JSON.parse(body.config);
    expect(config.provider.type).toBe("openai");
  });

  it("returns 404 when trying to update a non-existent workspace", async () => {
    const res = await app.request(
      url("/workspaces/00000000-0000-0000-0000-000000000000"),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Ghost",
          provider: validProviderPayload,
        }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /workspaces/:id", () => {
  it("deletes an existing workspace and returns { deleted: true }", async () => {
    const created = await (await createWorkspace()).json();

    const res = await app.request(url(`/workspaces/${created.id}`), {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);

    // Verify it is really gone
    const check = await app.request(url(`/workspaces/${created.id}`));
    expect(check.status).toBe(404);
  });

  it("returns 404 when trying to delete a non-existent workspace", async () => {
    const res = await app.request(
      url("/workspaces/00000000-0000-0000-0000-000000000000"),
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

// ---------------------------------------------------------------------------
// /tools, /runtime-status, /trace — endpoints added in PRs 26878 / 26912 /
// 26931. Tests use workspaces with empty mcp arrays so the routes don't
// require live MCP connections — covers shape + happy paths.
// ---------------------------------------------------------------------------

describe("GET /workspaces/:id/tools", () => {
  it("returns an empty array when the workspace has no MCP connections", async () => {
    const created = await (await createWorkspace()).json();
    const res = await app.request(url(`/workspaces/${created.id}/tools`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it("returns 404 for a non-existent workspace", async () => {
    const res = await app.request(
      url("/workspaces/00000000-0000-0000-0000-000000000000/tools"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /workspaces/:id/runtime-status", () => {
  it("returns the documented shape for a no-MCP / no-skills workspace", async () => {
    const created = await (await createWorkspace()).json();
    const res = await app.request(
      url(`/workspaces/${created.id}/runtime-status`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Top-level fields
    expect(body).toHaveProperty("tier");
    expect(body).toHaveProperty("providers");
    expect(body).toHaveProperty("mcp");
    expect(body).toHaveProperty("skills");
    expect(body).toHaveProperty("errors");

    // Tier must be one of the documented values. Exact value depends on
    // the skill-registry singleton state, which is process-global and may
    // be initialized differently across test-file load orders — assert
    // the contract, not the specific outcome.
    expect(["skill-router", "category-discovery", "flat"]).toContain(body.tier);

    // No MCP, no errors
    expect(body.mcp).toEqual([]);
    expect(body.errors).toEqual([]);

    // Providers list — must be an array. Length depends on the
    // providers.js mock state in the bun module cache (integration.test.ts
    // mocks listProviders to return [] in some load orders), so we
    // contract the shape only, not the count. Per-entry shape contracted
    // when the array is non-empty.
    expect(Array.isArray(body.providers)).toBe(true);
    for (const p of body.providers) {
      expect(typeof p.type).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(typeof p.configured).toBe("boolean");
      if (!p.configured) {
        expect(typeof p.missingEnvVar).toBe("string");
      }
    }

    // Skills summary shape
    expect(body.skills).toHaveProperty("loaded");
    expect(body.skills).toHaveProperty("experts");
    expect(body.skills).toHaveProperty("actionable");
    expect(Array.isArray(body.skills.details)).toBe(true);
  });

  it("returns 404 for a non-existent workspace", async () => {
    const res = await app.request(
      url("/workspaces/00000000-0000-0000-0000-000000000000/runtime-status"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /workspaces/:id/trace", () => {
  it("returns the workspace's trace buffer (initially empty)", async () => {
    const created = await (await createWorkspace()).json();
    const res = await app.request(url(`/workspaces/${created.id}/trace`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("?clear=1 empties the buffer after returning it", async () => {
    const created = await (await createWorkspace()).json();
    const { appendTrace, getTrace } = await import("../lib/trace-buffer.js");

    appendTrace(created.id, {
      timestamp: new Date().toISOString(),
      direction: "ToMCP",
      type: "tool-call",
      message: "→ test_tool",
    });
    expect(getTrace(created.id)).toHaveLength(1);

    const res = await app.request(
      url(`/workspaces/${created.id}/trace?clear=1`),
    );
    expect(res.status).toBe(200);
    const returned = await res.json();
    expect(returned).toHaveLength(1);

    // Buffer should be empty after the clear query param
    expect(getTrace(created.id)).toHaveLength(0);
  });
});
