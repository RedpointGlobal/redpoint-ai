import { db } from "./db.js";
import { WORKSPACE_NAMES, LEGACY_WORKSPACE_NAMES } from "@redpoint-ai/shared";
import { workspaces, threads, apiKeys, auditLogs } from "./schema.js";
import { randomUUID } from "crypto";
import { count, eq } from "drizzle-orm";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

// Pick the seeded workspaces' default provider by which LLM key is actually
// present in the environment. Without this, an Anthropic-only contributor
// (the lowest-friction key, and the prominent one in .env.example) gets
// seeded workspaces hardcoded to Azure that fail on the first chat message
// (provider-seed audit).
//
// Azure-first precedence is deliberate: it preserves byte-identical behavior
// for every existing Azure install (zero regression). Anthropic/OpenAI only
// win when no Azure key is set. Zero keys → keep Azure as the documented
// default; `bun run check` already warns on missing keys at install time, so
// the seed must not hard-fail here.
//
// Model ids match what the rest of the codebase uses (docs):
// claude-sonnet-4-6 for Anthropic, gpt-4o for OpenAI. Azure routes to the
// gpt-4.1 deployment — a separate, less-contended TPM bucket than the
// shared gpt-4o deployment on the resource (each Azure deployment id is its
// own per-minute token bucket). The Anthropic id is the current native string per the
// installed @ai-sdk/anthropic package literals (a refresh updated the
// repo-wide pin from the stale claude-sonnet-4-20250514). Verify the id
// against the installed SDK package, NOT the Vercel ai-gateway namespace
// (gateway uses dotted `claude-sonnet-4.6`; the native SDK call here
// needs the hyphenated form).
export function pickDefaultProvider() {
  // Model/deployment are env-overridable. Without this, AZURE_OPENAI_DEPLOYMENT_ID
  // ships in .env, in the bundle .env and in docker-compose yet nothing reads it
  // at runtime — an operator repoints it, restarts, and nothing changes because
  // the model lives in the workspace row. With the settings UI gone the
  // environment is the ONLY way to choose a model, so it has to be wired.
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4.1";
  if (process.env.AZURE_OPENAI_API_KEY) {
    return {
      type: "azure-openai",
      model: process.env.AZURE_OPENAI_MODEL || azureDeployment,
      azureDeployment,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      type: "anthropic",
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return { type: "openai", model: process.env.OPENAI_MODEL || "gpt-4o" };
  }
  return {
    type: "azure-openai",
    model: process.env.AZURE_OPENAI_MODEL || azureDeployment,
    azureDeployment,
  };
}

const DEFAULT_PROVIDER = pickDefaultProvider();

// MCP URL defaults to localhost (works for `bun run dev` where everything
// shares the host's loopback). docker-compose overrides via SEED_RPI_MCP_URL
// to point at the mcp-rpi service name on the compose network.
const DEFAULT_MCP_URL = process.env.SEED_RPI_MCP_URL || "http://localhost:3002/mcp";

const RPI_SYSTEM_PROMPT = `You are RedpointAI, the official AI assistant for Redpoint Interaction (RPI) by Redpoint Global.

# CRITICAL CONTEXT
"RPI" in this application means Redpoint Interaction. It does NOT mean Retail Price Index, Rensselaer Polytechnic Institute, Raspberry Pi, or any other meaning. Every user question mentioning "RPI" is about the Redpoint Interaction platform. Never disambiguate or ask which RPI they mean.

# What is RPI (Redpoint Interaction)?
Redpoint Interaction is an enterprise customer data platform (CDP) built by Redpoint Global for marketing teams. Core capabilities:
- **Audience Segmentation**: Static, dynamic, and composite audiences with RFM scoring
- **Campaign Orchestration**: Multi-wave workflows, decision nodes, A/B testing, holdout groups
- **Realtime Decisioning**: Next-best-action (NBA), next-best-offer (NBO), sub-100ms arbitration
- **Cross-Channel Execution**: Email, SMS, push, web, direct mail — unified frequency capping
- **Identity Resolution**: Deterministic + probabilistic matching, household linkage, persistent master IDs
- **Single Customer View (SCV)**: Unified golden record across all data sources

You have deep domain expertise in RPI. Answer all questions authoritatively using the Domain Knowledge provided below. When users need to execute operations (create audiences, run campaigns, pull reports), use the execute_skill tool.`;

// Landing-page card copy. One sentence of identity, then what's loaded, then
// where the MCP server lives — same shape for every product workspace.
const RPI_WORKSPACE_DESCRIPTION =
  "AI Agent for Redpoint Interaction. RPI foundation + domain knowledge experts are loaded. The local RPI MCP server is available on port :3002";

const DEFAULT_WORKSPACES = [
  {
    name: WORKSPACE_NAMES.rpi,
    description: RPI_WORKSPACE_DESCRIPTION,
    config: {
      provider: DEFAULT_PROVIDER,
      // Product short code (RPI / DRH), shown as a badge beside the product name
      // on the landing-page card. RedpointAI is the parent platform, not a
      // product — the products are Redpoint Interaction and Data Readiness Hub.
      shortName: "RPI",
      agent: {
        systemPrompt: RPI_SYSTEM_PROMPT,
        maxSteps: 20,
      },
      mcp: [
        { name: "rpi", transport: "http", url: DEFAULT_MCP_URL },
      ],
      skills: [
        // Inlined-knowledge layer — the cross-cutting foundation expert is
        // inlined into the router prompt (X-ClientID, RPI terminology, error
        // patterns). Always-on house style for every RPI call.
        "rpi-foundation-expert",
        // Dispatched-knowledge layer — the RPI domain expert. A tool-less,
        // WHAT-only expert (dispatch: true): catalogued and reached via
        // execute_skill on a knowledge-intent hit, NOT inlined, so its body
        // costs the parent prompt nothing.
        "rpi-domain-expert",
        // Action layer — the router catalog. Each is type: action with an
        // explicit mcpToolFilter scoped to one MCP category. The router
        // dispatches via execute_skill; sub-agents see only their tools.
        "rpi-audiences",
        "rpi-clients",
        "rpi-folders",
        "rpi-interactions",
        "rpi-selection-rules",
        "rpi-admin",
      ],
      suggestions: [
        "Check my RPI connection...",
        "List my clients...",
        "List my selection rules...",
        "List my audiences...",
        "List my interactions...",
        "List my folders...",
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Data Readiness Hub workspace — seeded UNCONDITIONALLY, so both product cards
// always render. It is upserted by name (idempotent — see ensureDrhWorkspace)
// so it appears even on an already-seeded DB, and wires the DRH MCP server
// (:3003) + the DRH skills over its 93-tool surface.
//
// It used to be seeded only when DRH_API_URL was set, which paired with
// enforceCanonicalWorkspaces to make a missing variable destructive: the
// workspace became "unexpected", its conversations were reparented into
// Redpoint Interaction and the row deleted. An unconfigured backend now yields
// a workspace whose MCP server simply isn't reachable — a display concern, not
// a data one.
//
// Credentials live in the MCP server's env (root .env in dev, key vault when
// hosted) — never in this workspace config.
// ---------------------------------------------------------------------------
const DRH_MCP_URL = process.env.DRH_MCP_URL || "http://localhost:3003/mcp";

const DRH_SYSTEM_PROMPT = `You are RedpointAI, the official AI assistant for Redpoint Data Readiness Hub (DRH) by Redpoint Global.

The Data Readiness Hub is where a deployment assesses whether its data is fit to use — data sources, readiness checks, and the overall data-readiness picture. Answer conceptual/how-to questions from the Domain Knowledge provided below. When the user wants to list, fetch, or check the status of their actual data sources, use the execute_skill tool to dispatch a Data Readiness Hub action skill.`;

const DRH_WORKSPACE = {
  name: WORKSPACE_NAMES.drh,
  description:
    "AI Agent for Data Readiness Hub. DRH foundation + domain knowledge experts are loaded. The local DRH MCP server is available on port :3003",
  config: {
    provider: DEFAULT_PROVIDER,
    // Product short code — shown as a badge beside the product name on the card.
    shortName: "DRH",
    agent: {
      systemPrompt: DRH_SYSTEM_PROMPT,
      maxSteps: 20,
    },
    mcp: [{ name: "drh", transport: "http", url: DRH_MCP_URL }],
    skills: [
      "drh-foundation-expert",
      "drh-domain-expert",
      "drh-datasources",
      "drh-feeds",
      "drh-runs",
      "drh-data-quality",
      "drh-schedules",
    ],
    suggestions: [
      "What is a data source in the Data Readiness Hub?",
      "List my data sources...",
      "What's my data readiness status?",
    ],
  },
};

/**
 * Lazy schema bootstrap. If the `workspaces` table doesn't exist yet (fresh
 * clone, never started before), spawn drizzle-kit push to apply the schema,
 * then proceed to seed default workspaces. drizzle-kit push is idempotent —
 * no-op if the schema is already current.
 */
function bootstrapSchemaIfMissing(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // apps/server/src/store/seed.ts → drizzle-kit shim is at apps/server/node_modules/.bin/drizzle-kit
  const shimPath = join(__dirname, "..", "..", "node_modules", ".bin", "drizzle-kit");
  if (!existsSync(shimPath)) {
    // node_modules not installed yet — should have been by `bun install`. Loud error.
    throw new Error(
      `[seed] drizzle-kit shim missing at ${shimPath} — run \`bun install\` first.`,
    );
  }
  console.log("[seed] applying schema via drizzle-kit push (idempotent)…");
  const proc = spawnSync(shimPath, ["push"], {
    cwd: join(__dirname, "..", ".."),
    stdio: "inherit",
  });
  if (proc.status !== 0) {
    throw new Error(`[seed] drizzle-kit push failed (exit ${proc.status})`);
  }
}

export async function seedDefaults(): Promise<void> {
  // Server "just works" on first start: if the workspaces table is missing,
  // bootstrap the schema in-process via drizzle-kit push, then seed defaults.
  let total: number;
  try {
    const result = await db.select({ total: count() }).from(workspaces);
    total = result[0].total;
  } catch {
    bootstrapSchemaIfMissing();
    const result = await db.select({ total: count() }).from(workspaces);
    total = result[0].total;
  }
  // Bring legacy names up to the product names before anything keys off them.
  await renameLegacyWorkspaces();
  await enforceRpiWorkspaceConfig();

  // Seed the shipped defaults only on an empty DB (unchanged behavior).
  if (total === 0) {
    const now = new Date();
    for (const ws of DEFAULT_WORKSPACES) {
      await db.insert(workspaces).values({
        id: randomUUID(),
        name: ws.name,
        description: ws.description,
        config: JSON.stringify(ws.config),
        createdAt: now,
        updatedAt: now,
      });
    }
    console.log(`Seeded ${DEFAULT_WORKSPACES.length} default workspaces`);
  }

  // Idempotent — runs regardless of the empty-DB guard above so the DR Hub
  // workspace can be added to an existing DB. No-op unless DR Hub is configured.
  await ensureDrhWorkspace();

  // Final guarantee: the workspace table holds EXACTLY the seeded set.
  await enforceCanonicalWorkspaces();
}

/**
 * DETERMINISTIC GUARANTEE: after seeding, the workspaces table holds exactly the
 * seeded set — Redpoint Interaction, plus Data Readiness Hub when DRH is
 * configured. Nothing else, and never a duplicate.
 *
 * The rename step above handles the known upgrade paths, but this is the
 * backstop: it doesn't care HOW a stray row got there (an older build's seed, an
 * interrupted migration, a hand-edited DB). Anything outside the expected set is
 * removed, and if two rows somehow share a name the oldest wins.
 *
 * Safe because workspaces are created ONLY by this seed — the product exposes no
 * way for a user to add one, so a stray row is always machine-made debris, never
 * someone's work. Threads / API keys / audit rows are moved to the surviving
 * workspace of the same product first (falling back to the primary workspace),
 * so healing the card list never costs a conversation.
 */
async function enforceCanonicalWorkspaces(): Promise<void> {
  // Both product workspaces are ALWAYS expected. Deliberately not gated on
  // DRH_API_URL: provisioning conditions decide whether a workspace is CREATED,
  // never whether an existing one is destroyed. Gating this meant an absent or
  // typo'd DRH_API_URL deleted the Data Readiness Hub workspace and relocated
  // its conversations into Redpoint Interaction — a data event triggered by a
  // missing environment variable, which is exactly what a transient Key Vault
  // hiccup looks like at boot.
  const expected = new Set<string>([
    ...DEFAULT_WORKSPACES.map((w) => w.name),
    DRH_WORKSPACE.name,
  ]);

  interface WsRow {
    id: string;
    name: string;
    createdAt: Date | number;
  }
  const all: WsRow[] = await db
    .select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
    .from(workspaces);
  // Oldest first, so the survivor of any name collision is the original row
  // (the one history is already attached to).
  all.sort((a: WsRow, b: WsRow) => Number(a.createdAt) - Number(b.createdAt));

  const survivors = new Map<string, string>(); // name -> id
  const doomed: Array<{ id: string; name: string }> = [];
  for (const ws of all) {
    if (!expected.has(ws.name) || survivors.has(ws.name)) {
      doomed.push({ id: ws.id, name: ws.name });
      continue;
    }
    survivors.set(ws.name, ws.id);
  }
  if (doomed.length === 0) return;

  // Prefer the same-product survivor; otherwise the primary workspace.
  const legacyToCanonical = new Map<string, string>(
    LEGACY_WORKSPACE_RENAMES.map(({ from, to }) => [from, to]),
  );
  const primaryId = survivors.get(DEFAULT_WORKSPACES[0].name);

  for (const ws of doomed) {
    const targetName = legacyToCanonical.get(ws.name) ?? ws.name;
    const keepId = survivors.get(targetName) ?? primaryId;
    // No survivor to move anything onto — leave the row alone. threads carry
    // onDelete: "cascade" (schema.ts) and messages/runs cascade off threads, so
    // deleting here would not orphan the conversation, it would DESTROY it.
    // Tidying the card list is never worth silently losing history; an extra row
    // is visible and recoverable, deleted messages are neither.
    if (!keepId) {
      console.warn(
        `[seed] leaving unexpected workspace "${ws.name}" in place — no surviving ` +
          `workspace to move its conversations to, and deleting would cascade them away`,
      );
      continue;
    }
    {
      await db
        .update(threads)
        .set({ workspaceId: keepId, updatedAt: new Date() })
        .where(eq(threads.workspaceId, ws.id));
      await db
        .update(apiKeys)
        .set({ workspaceId: keepId })
        .where(eq(apiKeys.workspaceId, ws.id));
      await db
        .update(auditLogs)
        .set({ workspaceId: keepId })
        .where(eq(auditLogs.workspaceId, ws.id));
    }
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    console.log(
      `[seed] removed unexpected workspace "${ws.name}" — the seeded set is ` +
        `${[...expected].map((n) => `"${n}"`).join(" + ")}`,
    );
  }
}

/**
 * One-time rename of the legacy workspace names to the real product names.
 *
 * RedpointAI is the parent PLATFORM, not a product — the products are Redpoint
 * Interaction (RPI) and Data Readiness Hub (DRH); "DR Hub" is retired. Existing
 * databases were seeded as "RedpointAI" / "DR Hub", and because both the
 * first-run seed and ensureDrhWorkspace key off the NAME, renaming in the seed
 * alone would insert a SECOND workspace beside the old one (4 cards). Renaming
 * in place first keeps an upgraded DB — dev SQLite or the bundle's server-data
 * volume — showing the same two workspaces under their correct names.
 *
 * Skips when a row already carries the new name, so it can never collapse or
 * duplicate a workspace a user created themselves.
 */
const LEGACY_WORKSPACE_RENAMES = [
  { from: LEGACY_WORKSPACE_NAMES.rpi, to: WORKSPACE_NAMES.rpi },
  { from: LEGACY_WORKSPACE_NAMES.drh, to: WORKSPACE_NAMES.drh },
] as const;

async function renameLegacyWorkspaces(): Promise<void> {
  for (const { from, to } of LEGACY_WORKSPACE_RENAMES) {
    const legacy = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.name, from));
    if (legacy.length === 0) continue;

    const alreadyRenamed = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.name, to));
    if (alreadyRenamed.length > 0) {
      // Both names present. This is the DOWNGRADE -> UPGRADE path: someone ran a
      // build predating the rename, whose seed didn't find its legacy name (we'd
      // already renamed it) and re-inserted a fresh legacy row. Merely skipping
      // here would strand that duplicate FOREVER — a permanent third card on the
      // landing page.
      //
      // Workspaces are created ONLY by this seed (the product exposes no way for
      // a user to add one), so the duplicate is never something a person authored
      // — both rows are the same product. Move anything hanging off the stale row
      // onto the canonical one, then drop it: exactly two cards, no history lost.
      const staleId = legacy[0].id;
      const keepId = alreadyRenamed[0].id;
      const stamp = { updatedAt: new Date() };
      await db
        .update(threads)
        .set({ workspaceId: keepId, ...stamp })
        .where(eq(threads.workspaceId, staleId));
      await db
        .update(apiKeys)
        .set({ workspaceId: keepId })
        .where(eq(apiKeys.workspaceId, staleId));
      await db
        .update(auditLogs)
        .set({ workspaceId: keepId })
        .where(eq(auditLogs.workspaceId, staleId));
      await db.delete(workspaces).where(eq(workspaces.id, staleId));
      console.log(
        `[seed] removed stale duplicate workspace "${from}" (superseded by "${to}"); ` +
          `any threads/keys/audit rows were moved to the surviving workspace`,
      );
      continue;
    }

    await db
      .update(workspaces)
      .set({ name: to, updatedAt: new Date() })
      .where(eq(workspaces.id, legacy[0].id));
    console.log(`[seed] renamed workspace "${from}" -> "${to}"`);
  }
}

/**
 * Rewrite the Redpoint Interaction workspace from the seed on every boot.
 *
 * The seed is authoritative: configuration comes from code (this file) plus the
 * environment — .env for OSS, key vault when hosted — and nowhere else, since
 * the workspace settings UI that used to write here has been removed. Nothing
 * stored is preserved, `provider` included: it is derived by
 * pickDefaultProvider() from the environment, so keeping a stored copy would
 * pin a workspace to a provider whose key may since have been removed.
 *
 * This is also the upgrade path. DEFAULT_WORKSPACES is only inserted into an
 * EMPTY database, so without this an existing install keeps whatever it was
 * first seeded with — a workspace created before rpi-domain-expert shipped
 * would never receive it, and one left holding only expert skills has no
 * execute_skill tool at all, quietly dropping the router to
 * category-discovery. Matches what ensureDrhWorkspace() does for Data Readiness
 * Hub: every install converges on exactly what we ship.
 */
async function enforceRpiWorkspaceConfig(): Promise<void> {
  const rpi = DEFAULT_WORKSPACES[0];
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.name, rpi.name));
  if (existing.length === 0) return;

  // THE SEED IS AUTHORITATIVE. Configuration comes from code (this file) plus the
  // environment — .env for OSS, key vault when hosted — and nowhere else; the
  // workspace settings UI that used to write here has been removed. So rewrite
  // the whole config on every boot and preserve NOTHING, including `provider`:
  // it is derived by pickDefaultProvider() from the environment, so keeping a
  // stored copy would pin a workspace to a provider whose key may since have
  // been removed (swap Azure -> Anthropic in .env and the row would still point
  // at the dead Azure block).
  //
  // This also fixes the upgrade path. DEFAULT_WORKSPACES is only inserted into
  // an EMPTY database, so without a refresh an existing install keeps whatever
  // it was first seeded with — a workspace created before rpi-domain-expert
  // shipped would never receive it, and one left holding only expert skills has
  // no execute_skill tool at all, quietly dropping the router to
  // category-discovery. Matches what ensureDrhWorkspace() already does for Data
  // Readiness Hub: every install converges on exactly what we ship.
  await db
    .update(workspaces)
    .set({
      description: rpi.description,
      config: JSON.stringify(rpi.config),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, existing[0].id));
}

/**
 * Upsert the Data Readiness Hub workspace. Idempotent: inserts once (by name),
 * refreshes config if it already exists.
 *
 * Seeded UNCONDITIONALLY — both product cards always render, whether or not DRH
 * is configured. It previously no-op'd unless DRH_API_URL was set, which paired
 * with the reaper to make a missing variable destructive (see
 * enforceCanonicalWorkspaces). An unconfigured DRH now yields a workspace whose
 * MCP server simply isn't reachable, which is a display concern rather than a
 * data one.
 *
 * The workspace config carries NO credentials — those live in the MCP server's
 * env (root .env in dev, key vault when hosted).
 */
async function ensureDrhWorkspace(): Promise<void> {
  const now = new Date();
  const config = JSON.stringify(DRH_WORKSPACE.config);
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.name, DRH_WORKSPACE.name));

  // True upsert: on a DB that already has the workspace, refresh its config
  // (skills/description) so iterating on the DR Hub skills/experts takes effect
  // on restart.
  if (existing.length > 0) {
    await db
      .update(workspaces)
      .set({ description: DRH_WORKSPACE.description, config, updatedAt: now })
      .where(eq(workspaces.id, existing[0].id));
    console.log(
      `[seed] refreshed workspace "${DRH_WORKSPACE.name}" config`,
    );
    return;
  }

  await db.insert(workspaces).values({
    id: randomUUID(),
    name: DRH_WORKSPACE.name,
    description: DRH_WORKSPACE.description,
    config,
    createdAt: now,
    updatedAt: now,
  });
  console.log(
    `[seed] seeded workspace "${DRH_WORKSPACE.name}"`,
  );
}
