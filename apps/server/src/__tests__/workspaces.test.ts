/**
 * Integration tests for the workspace CRUD routes.
 *
 * Strategy: use Bun's mock.module() to replace the `db` singleton with an
 * in-memory SQLite/Drizzle instance so tests are fully isolated from the
 * filesystem database and from each other.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import { WORKSPACE_NAMES } from "@redpoint-ai/shared";
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

// No literal apiKey: secrets live in the environment (.env for OSS, key vault
// when hosted), and the schema now rejects one stored on the workspace row.
const validProviderPayload = {
  type: "anthropic",
  model: "claude-opus-4-5",
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

// ---------------------------------------------------------------------------
// DRH card gating on DRH_API_URL (read-path list filter).
//
// The Data Readiness Hub is an optional module: its card tracks provisioning.
// When DRH_API_URL is unset the DRH workspace is filtered from GET /workspaces
// so the card doesn't render. This is a READ-PATH filter only — the row and its
// threads survive and GET /:id still resolves, so a bookmarked chat stays
// reachable and the card returns intact when keys return. Gating the SEED /
// enforceCanonicalWorkspaces on DRH_API_URL is the historical data-loss bug and
// is guarded separately in seed-migration.test.ts; those stay unconditional.
// ---------------------------------------------------------------------------

describe("GET /workspaces — DRH card gating on DRH_API_URL", () => {
  const savedDrhUrl = process.env.DRH_API_URL;

  beforeAll(() => {
    testDb.run(sql`
      CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    sqlite.run("DELETE FROM threads");
    // Restore the ambient value so other suites aren't affected.
    if (savedDrhUrl === undefined) delete process.env.DRH_API_URL;
    else process.env.DRH_API_URL = savedDrhUrl;
  });

  // Seed the DRH workspace + an always-rendered RPI workspace + one DRH thread,
  // so "row + threads survive" is a real assertion, not a structural inference.
  async function seedBothPlusDrhThread(): Promise<string> {
    const drh = await (await createWorkspace(WORKSPACE_NAMES.drh)).json();
    await createWorkspace(WORKSPACE_NAMES.rpi);
    const now = Date.now();
    sqlite.run(
      "INSERT INTO threads (id, workspace_id, title, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["drh-thread-1", drh.id, "DRH chat", now, now],
    );
    return drh.id as string;
  }

  it("DRH_API_URL set → Data Readiness Hub is listed alongside RPI", async () => {
    process.env.DRH_API_URL = "https://drh.test.invalid";
    await seedBothPlusDrhThread();

    const body = await (await app.request(url("/workspaces"))).json();
    const names = body.map((w: { name: string }) => w.name);
    expect(names).toContain(WORKSPACE_NAMES.drh);
    expect(names).toContain(WORKSPACE_NAMES.rpi);
  });

  it("DRH_API_URL unset → card filtered from the list, but row + thread survive and /:id resolves", async () => {
    // Empty string is falsy, matching the route's `process.env.DRH_API_URL` check.
    process.env.DRH_API_URL = "";
    const drhId = await seedBothPlusDrhThread();

    // Card gone from the landing list; RPI always renders.
    const body = await (await app.request(url("/workspaces"))).json();
    const names = body.map((w: { name: string }) => w.name);
    expect(names).not.toContain(WORKSPACE_NAMES.drh);
    expect(names).toContain(WORKSPACE_NAMES.rpi);

    // Row survives — GET /:id still resolves (deep link / history reachable).
    const byId = await app.request(url(`/workspaces/${drhId}`));
    expect(byId.status).toBe(200);
    expect((await byId.json()).name).toBe(WORKSPACE_NAMES.drh);

    // Threads survive — a read filter never touches data.
    const row = sqlite
      .query("SELECT COUNT(*) AS count FROM threads WHERE workspace_id = ?")
      .get(drhId) as { count: number };
    expect(row.count).toBe(1);
  });

  it("keys return → card returns intact (dynamic, no stale state)", async () => {
    process.env.DRH_API_URL = "";
    await seedBothPlusDrhThread();
    let names = (await (await app.request(url("/workspaces"))).json()).map(
      (w: { name: string }) => w.name,
    );
    expect(names).not.toContain(WORKSPACE_NAMES.drh);

    process.env.DRH_API_URL = "https://drh.test.invalid";
    names = (await (await app.request(url("/workspaces"))).json()).map(
      (w: { name: string }) => w.name,
    );
    expect(names).toContain(WORKSPACE_NAMES.drh);
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

  it("rejects a literal provider apiKey — secrets belong in the environment", async () => {
    // A literal key here would sit in plaintext in the workspaces row (and so in
    // the docker bundle's server-data volume), and createModelFromConfig prefers
    // config.apiKey over process.env, so it would silently shadow the configured
    // environment. Policy is .env for OSS / key vault when hosted.
    const created = await (await createWorkspace()).json();

    const res = await app.request(url(`/workspaces/${created.id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Leaky",
        provider: { type: "openai", model: "gpt-4o", apiKey: "sk-literal-secret" },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("accepts an apiKey that references an environment variable", async () => {
    const created = await (await createWorkspace()).json();

    const res = await app.request(url(`/workspaces/${created.id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Indirect",
        provider: {
          type: "openai",
          model: "gpt-4o",
          apiKey: "${OPENAI_API_KEY}",
        },
      }),
    });

    expect(res.status).toBe(200);
    const config = JSON.parse((await res.json()).config);
    expect(config.provider.apiKey).toBe("${OPENAI_API_KEY}");
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
// /tools, /runtime-status, /trace — tool / status / trace endpoints. Tests
// use workspaces with empty mcp arrays so the routes don't
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
