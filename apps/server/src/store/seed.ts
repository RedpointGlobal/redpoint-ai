import { db } from "./db.js";
import { workspaces } from "./schema.js";
import { randomUUID } from "crypto";
import { count } from "drizzle-orm";
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
  if (process.env.AZURE_OPENAI_API_KEY) {
    return { type: "azure-openai", model: "gpt-4.1", azureDeployment: "gpt-4.1" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { type: "anthropic", model: "claude-sonnet-4-6" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { type: "openai", model: "gpt-4o" };
  }
  return { type: "azure-openai", model: "gpt-4.1", azureDeployment: "gpt-4.1" };
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

const DEFAULT_WORKSPACES = [
  {
    name: "RedpointAI",
    description:
      "AI Agent Platform for Redpoint Interaction. RPI domain experts loaded; local RPI MCP server wired at :3002.",
    config: {
      provider: DEFAULT_PROVIDER,
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
  if (total > 0) return;

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
