/**
 * Seed workspace-identity migration — the UPGRADE path.
 *
 * RedpointAI is the parent platform; the products are Redpoint Interaction (RPI)
 * and Data Readiness Hub (DRH). Databases seeded before that rename carry the
 * legacy names "RedpointAI" / "DR Hub". Both the first-run seed and
 * ensureDrhWorkspace key off the NAME, so renaming the seed alone would INSERT a
 * second workspace beside each legacy row — a user upgrading (dev SQLite, or the
 * docker bundle's server-data volume) would suddenly see four cards.
 *
 * These cases were first caught by a throwaway harness; they live here so the
 * upgrade path can't silently regress. Two bugs it already caught:
 *   1. an in-process harness reused the cached db singleton, so every "boot"
 *      after the first wrote to the same file and the run was meaningless —
 *      hence the SEPARATE PROCESS per boot below;
 *   2. the RPI row kept its pre-rename `config.shortName`, rendering the card as
 *      "Redpoint Interaction  Redpoint Interaction (RPI)".
 *
 * Strategy: drive the real seedDefaults() against throwaway SQLite files in a
 * child process (store/db.ts opens its connection at import time and caches it,
 * so DB_FILE_NAME must differ per process). The table DDL below mirrors
 * store/schema.ts for just the columns the seed touches.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { WORKSPACE_NAMES, LEGACY_WORKSPACE_NAMES } from "@redpoint-ai/shared";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SEED_ENTRY = join(REPO_ROOT, "apps/server/src/store/seed.ts");

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "rpai-seedmig-"));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Mirrors store/schema.ts (workspaces + threads) for the columns seeding uses. */
function makeDb(path: string, mode: "empty" | "legacy"): void {
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    config TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id))`);
  db.run(`CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id))`);

  if (mode === "legacy") {
    const now = Date.now();
    db.run(
      "INSERT INTO workspaces (id,name,description,config,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [
        "legacy-rpi-id",
        LEGACY_WORKSPACE_NAMES.rpi,
        "AI Agent Platform for Redpoint Interaction. RPI domain experts loaded; local RPI MCP server wired at :3002.",
        JSON.stringify({
          shortName: "Redpoint Interaction (RPI)",
          provider: { type: "anthropic", model: "user-picked-model" },
          mcp: [{ name: "rpi" }],
          // A pre-rename install predates later skills — only the foundation
          // expert. Nothing action-shaped, so the router has no execute_skill.
          skills: ["rpi-foundation-expert", "my-custom-skill"],
          // Stale values a real upgrade would carry. The settings page that
          // once wrote these is gone and the seed is now authoritative, so the
          // assertions below expect every one of them to be REPLACED.
          agent: { systemPrompt: "USER EDITED PROMPT", maxSteps: 42 },
          suggestions: ["my own suggestion"],
        }),
        now,
        now,
      ],
    );
    db.run(
      "INSERT INTO workspaces (id,name,description,config,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [
        "legacy-drh-id",
        LEGACY_WORKSPACE_NAMES.drh,
        "DR Hub workspace — pre-rename copy.",
        JSON.stringify({ shortName: "Data Readiness Hub (DRH)", mcp: [{ name: "drh" }] }),
        now,
        now,
      ],
    );
    // User data on the legacy row must survive an in-place rename.
    db.run(
      "INSERT INTO threads (id,workspace_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
      ["thread-1", "legacy-drh-id", "pre-rename conversation", now, now],
    );
  }
  db.close();
}

/**
 * Run seedDefaults() in its own process against `path`.
 *
 * `env` is per-call on purpose. DRH_API_URL used to be hardcoded here, so every
 * case ran DRH-configured and the unconfigured path was structurally
 * unreachable — no assertion could have caught the bug where a missing variable
 * deleted the Data Readiness Hub workspace. Mutation testing can't help with
 * that: it validates the assertions you wrote, it can't invent a scenario you
 * never expressed.
 */
function boot(path: string, opts: { unset?: string[] } = {}): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DB_FILE_NAME: path,
    DRH_API_URL: "https://drh.test.invalid",
  };
  // Set to "" rather than deleting. The child `bun` auto-loads the repo's root
  // .env from cwd, which defines DRH_API_URL — so deleting the key (or assigning
  // undefined) changes nothing: the file puts it back and the "unconfigured"
  // case silently ran configured, passing with the bug still in place. An
  // explicitly-passed empty string beats the .env file and is falsy, which is
  // exactly what the production check (`if (process.env.DRH_API_URL)`) reads.
  for (const key of opts.unset ?? []) env[key] = "";

  const proc = Bun.spawnSync(
    ["bun", "-e", `const s = await import(${JSON.stringify(SEED_ENTRY)}); await s.seedDefaults();`],
    { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`seed boot failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
}

interface Row {
  id: string;
  name: string;
  description: string;
  config: string;
}

function read(path: string): { rows: Row[]; threadWorkspaceIds: string[] } {
  const db = new Database(path);
  const rows = db
    .query("SELECT id,name,description,config FROM workspaces ORDER BY name")
    .all() as Row[];
  const threads = db.query("SELECT workspace_id FROM threads").all() as Array<{
    workspace_id: string;
  }>;
  db.close();
  return { rows, threadWorkspaceIds: threads.map((t) => t.workspace_id) };
}

function expectCanonicalPair(rows: Row[]): void {
  expect(rows.map((r) => r.name).sort()).toEqual(
    [WORKSPACE_NAMES.drh, WORKSPACE_NAMES.rpi].sort(),
  );
  for (const [key, short, port] of [
    ["rpi", "RPI", ":3002"],
    ["drh", "DRH", ":3003"],
  ] as const) {
    const row = rows.find((r) => r.name === WORKSPACE_NAMES[key])!;
    expect(JSON.parse(row.config).shortName).toBe(short);
    expect(row.description).toStartWith(`AI Agent for ${WORKSPACE_NAMES[key]}.`);
    expect(row.description).toContain(
      `${short} foundation + domain knowledge experts are loaded`,
    );
    expect(row.description).toEndWith(`available on port ${port}`);
  }
}

describe("seed — product workspace identity + legacy rename", () => {
  it("seeds exactly the two product workspaces on an empty DB", () => {
    const path = join(workDir, "empty.db");
    makeDb(path, "empty");
    boot(path);

    const { rows } = read(path);
    expect(rows).toHaveLength(2);
    expectCanonicalPair(rows);
  });

  it("renames legacy workspaces IN PLACE instead of inserting duplicates", () => {
    const path = join(workDir, "legacy.db");
    makeDb(path, "legacy");
    boot(path);

    const { rows, threadWorkspaceIds } = read(path);
    // The whole point: still two rows, not four.
    expect(rows).toHaveLength(2);
    expectCanonicalPair(rows);
    expect(rows.map((r) => r.name)).not.toContain(LEGACY_WORKSPACE_NAMES.rpi);
    expect(rows.map((r) => r.name)).not.toContain(LEGACY_WORKSPACE_NAMES.drh);

    // Same rows, renamed — not fresh inserts (ids preserved => threads/history keep pointing at them).
    expect(rows.find((r) => r.name === WORKSPACE_NAMES.rpi)!.id).toBe("legacy-rpi-id");
    expect(rows.find((r) => r.name === WORKSPACE_NAMES.drh)!.id).toBe("legacy-drh-id");
    expect(threadWorkspaceIds).toEqual(["legacy-drh-id"]);
  });

  it("re-derives the provider from the environment rather than carrying a stored one", () => {
    // pickDefaultProvider() reads the environment, so a stored provider must not
    // win: swap keys in .env (Azure -> Anthropic) and a preserved block would
    // pin the workspace to a provider whose key is gone.
    const path = join(workDir, "provider.db");
    makeDb(path, "legacy"); // fixture pins anthropic/user-picked-model
    boot(path);

    const { rows } = read(path);
    const cfg = JSON.parse(rows.find((r) => r.name === WORKSPACE_NAMES.rpi)!.config);
    expect(cfg.provider.model).not.toBe("user-picked-model");
    expect(cfg.provider.type).toBeDefined();
  });

  it("heals a stale legacy row left behind by an older build (downgrade then upgrade)", () => {
    // Real scenario, hit during development: run a current build (rows renamed),
    // then run a build predating the rename. Its seed looks for "DR Hub", doesn't
    // find it, and inserts a FRESH legacy row — so the DB now holds both names.
    // Upgrading again must clear that duplicate; merely skipping it strands a
    // third card on the landing page forever.
    const path = join(workDir, "downgrade.db");
    makeDb(path, "legacy");
    boot(path); // upgrade: legacy rows renamed

    // Simulate the old build re-inserting its legacy workspace.
    const db = new Database(path);
    const now = Date.now();
    db.run(
      "INSERT INTO workspaces (id,name,description,config,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [
        "stale-drh-id",
        LEGACY_WORKSPACE_NAMES.drh,
        "DR Hub workspace — re-inserted by an older build.",
        JSON.stringify({ shortName: "Data Readiness Hub (DRH)", mcp: [{ name: "drh" }] }),
        now,
        now,
      ],
    );
    db.close();
    expect(read(path).rows).toHaveLength(3); // the bad state

    boot(path); // upgrade again — must heal

    const { rows } = read(path);
    expect(rows).toHaveLength(2);
    expectCanonicalPair(rows);
    expect(rows.map((r) => r.id)).not.toContain("stale-drh-id");
    // The canonical row (with the user's history) is the survivor.
    expect(rows.find((r) => r.name === WORKSPACE_NAMES.drh)!.id).toBe("legacy-drh-id");
  });

  it("moves conversations off a stale row before removing it — history survives, card count does not grow", () => {
    const path = join(workDir, "downgrade-with-threads.db");
    makeDb(path, "legacy");
    boot(path);

    const db = new Database(path);
    const now = Date.now();
    db.run(
      "INSERT INTO workspaces (id,name,description,config,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ["stale-with-data", LEGACY_WORKSPACE_NAMES.drh, "old", JSON.stringify({}), now, now],
    );
    db.run(
      "INSERT INTO threads (id,workspace_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
      ["t-stale", "stale-with-data", "chat on the stale row", now, now],
    );
    db.close();

    boot(path);

    const { rows, threadWorkspaceIds } = read(path);
    // Deterministic: back to the seeded set, no third card.
    expect(rows).toHaveLength(2);
    expectCanonicalPair(rows);
    expect(rows.map((r) => r.id)).not.toContain("stale-with-data");
    // ...and the conversation was carried over to the surviving DRH workspace.
    const drhId = rows.find((r) => r.name === WORKSPACE_NAMES.drh)!.id;
    const check = new Database(path);
    const moved = check
      .query("SELECT workspace_id FROM threads WHERE id = ?")
      .get("t-stale") as { workspace_id: string };
    check.close();
    expect(moved.workspace_id).toBe(drhId);
    expect(threadWorkspaceIds).not.toContain("stale-with-data");
  });

  it("removes ANY workspace outside the seeded set — the card count is capped at what the seed defines", () => {
    // Deterministic ceiling: the seed defines the products, so the table can never
    // hold more than that set. Not legacy-name-specific — an arbitrary row (junk
    // from an interrupted migration or a hand-edited DB) is swept too. Safe
    // because the product gives users no way to create a workspace.
    const path = join(workDir, "junk.db");
    makeDb(path, "legacy");
    boot(path);
    const seeded = read(path).rows.length;

    const db = new Database(path);
    const now = Date.now();
    for (const [id, name] of [
      ["junk-1", "Some Other Workspace"],
      ["junk-2", "Scratch"],
      ["junk-3", WORKSPACE_NAMES.rpi], // same-name duplicate: oldest must win
    ] as const) {
      db.run(
        "INSERT INTO workspaces (id,name,description,config,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        [id, name, "junk", JSON.stringify({}), now + 1000, now + 1000],
      );
    }
    db.close();
    expect(read(path).rows).toHaveLength(seeded + 3);

    boot(path);

    const { rows } = read(path);
    expect(rows).toHaveLength(seeded);
    expectCanonicalPair(rows);
    expect(rows.map((r) => r.id)).not.toContain("junk-1");
    expect(rows.map((r) => r.id)).not.toContain("junk-2");
    // The original RPI row survived the same-name collision, not the newcomer.
    expect(rows.find((r) => r.name === WORKSPACE_NAMES.rpi)!.id).toBe("legacy-rpi-id");
  });

  it("is authoritative: rewrites stale config from the seed on every boot", () => {
    // Config comes from code (the seed) plus the environment — .env for OSS, key
    // vault when hosted. The workspace settings UI that used to write here is
    // gone, so nothing else owns these fields and the seed simply wins.
    //
    // This is also the upgrade fix: DEFAULT_WORKSPACES is only inserted into an
    // EMPTY database, so without the rewrite an existing install keeps whatever
    // it was first seeded with — one created before rpi-domain-expert shipped
    // would never receive it, and one holding only expert skills has no
    // execute_skill tool, quietly dropping the router to category-discovery.
    const path = join(workDir, "authoritative.db");
    makeDb(path, "legacy"); // fixture carries a 1-skill list + stale prompt
    boot(path);

    const { rows } = read(path);
    const cfg = JSON.parse(rows.find((r) => r.name === WORKSPACE_NAMES.rpi)!.config);
    // Shipped skills are present, and the stale extras are gone.
    expect(cfg.skills).toContain("rpi-domain-expert");
    expect(cfg.skills).toContain("rpi-audiences");
    expect(cfg.skills).not.toContain("my-custom-skill");
    // Provider is re-derived from the environment, not carried over. The fixture
    // pinned anthropic/user-picked-model; the boot env supplies the real one, so
    // swapping keys in .env can never leave a workspace on a dead provider.
    expect(cfg.provider.model).not.toBe("user-picked-model");
    // Agent prompt and suggestions come from the seed too.
    expect(cfg.agent.systemPrompt).not.toBe("USER EDITED PROMPT");
    expect(cfg.suggestions).not.toEqual(["my own suggestion"]);
  });

  it("keeps the Data Readiness Hub workspace and its conversations when DRH_API_URL is unset", () => {
    // Regression: DRH used to be added to the expected set only when
    // DRH_API_URL was present, so an absent or typo'd variable made the
    // workspace "unexpected" — the reaper reparented its conversations into
    // Redpoint Interaction and deleted the row. A missing environment variable
    // must never be a data event; it is exactly what a transient Key Vault
    // hiccup looks like at boot.
    const path = join(workDir, "drh-unset.db");
    makeDb(path, "legacy");
    boot(path); // configured: legacy rows renamed, DRH present with its thread

    const before = read(path);
    const drhId = before.rows.find((r) => r.name === WORKSPACE_NAMES.drh)!.id;
    expect(before.threadWorkspaceIds).toContain(drhId);

    boot(path, { unset: ["DRH_API_URL"] }); // now unconfigured

    const after = read(path);
    expect(after.rows.map((r) => r.name)).toContain(WORKSPACE_NAMES.drh);
    expect(after.rows.find((r) => r.name === WORKSPACE_NAMES.drh)!.id).toBe(drhId);
    expect(after.threadWorkspaceIds).toContain(drhId); // conversation not relocated
    expect(after.rows).toHaveLength(2); // both cards still render
  });

  it("never deletes a workspace it cannot reparent — threads cascade, so a delete destroys them", () => {
    // threads -> workspaces is onDelete: "cascade" (schema.ts:14-16), and
    // messages/runs cascade off threads. The reaper reparented inside
    // `if (keepId)` but deleted unconditionally after it, so a doomed row with
    // no surviving workspace to move onto lost its conversations permanently —
    // not an orphan row, silent data loss.
    const path = join(workDir, "no-survivor.db");
    const db = new Database(path, { create: true });
    db.run(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      config TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id))`);
    db.run(`CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id))`);
    db.run("PRAGMA foreign_keys = ON");
    const now = Date.now();
    // An unexpected workspace holding conversations, and NO seeded product row
    // for the reaper to fall back to.
    db.run(
      "INSERT INTO workspaces (id,name,description,config,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ["orphan-ws", "Some Retired Product", "junk", JSON.stringify({}), now, now],
    );
    db.run(
      "INSERT INTO threads (id,workspace_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
      ["precious", "orphan-ws", "conversation with no home", now, now],
    );
    db.close();

    boot(path);

    const check = new Database(path);
    const thread = check
      .query("SELECT workspace_id FROM threads WHERE id = ?")
      .get("precious") as { workspace_id: string } | null;
    const survived = check
      .query("SELECT id FROM workspaces WHERE id = ?")
      .get("orphan-ws") as { id: string } | null;
    check.close();

    // The conversation is what matters; the row is kept because deleting it
    // would cascade the conversation away.
    expect(thread).not.toBeNull();
    expect(survived).not.toBeNull();
  });

  it("is idempotent across repeated boots", () => {
    const path = join(workDir, "repeat.db");
    makeDb(path, "legacy");
    boot(path);
    boot(path);
    boot(path);

    const { rows } = read(path);
    expect(rows).toHaveLength(2);
    expectCanonicalPair(rows);
  });
});
