import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load root .env for monorepo — Bun only auto-loads .env from cwd,
// which is apps/server/ when run via workspace filter.
const __serverDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(__serverDir, "../../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments (but not inside quoted values)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf("#");
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Secure-by-default: auth is REQUIRED unless AUTH_REQUIRED is explicitly "false".
// This mirrors the request-path middleware (which gates unless AUTH_REQUIRED ===
// "false"), so an UNSET AUTH_REQUIRED is auth-required here too. Refuse to boot
// in that mode without a real AUTH_SECRET — fail loud at startup naming what's
// missing, instead of silently signing JWTs with a placeholder / emitting
// cryptic 401s at request time. (The docker-compose default is `changeme-...`
// precisely so this trips.)
if (process.env.AUTH_REQUIRED !== "false") {
  const secret = process.env.AUTH_SECRET ?? "";
  if (!secret || secret.startsWith("changeme-")) {
    console.error(
      '[fatal] Auth is required (AUTH_REQUIRED is not "false") but AUTH_SECRET is ' +
        "missing or still the changeme-* placeholder. Either generate a secret " +
        "(`openssl rand -base64 32`) and set AUTH_SECRET in .env, or set " +
        "AUTH_REQUIRED=false for local dev/eval (runs everything as the service " +
        "account, no login).",
    );
    process.exit(1);
  }
}

import { Hono } from "hono";
import { logger } from "hono/logger";
import { healthRoutes } from "./routes/health.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { threadRoutes } from "./routes/threads.js";
import { chatRoutes } from "./routes/chat.js";
import { providerRoutes } from "./routes/providers.js";
import { authRoutes } from "./routes/auth.js";
import { metricsRoutes } from "./routes/metrics.js";
import { aguiRoutes } from "./routes/agui.js";
import { authMiddleware } from "./middleware/auth.js";
import { seedDefaults } from "./store/seed.js";
import { appCors } from "./cors.js";
import { RateLimiter, peerFloodLimit } from "./lib/rate-limit.js";
import { turnLimit, userRequestLimit } from "./lib/web-limits.js";
import { SERVE_MODE } from "./lib/serve-mode.js";

await seedDefaults();

const app = new Hono();

// CORS: the web UI's origin only (./cors.ts) — never "*".
app.use("*", appCors());
app.use("*", logger());

// Public routes (no auth required)
app.route("/api/v1", healthRoutes);
app.route("/metrics", metricsRoutes);

// The per-peer flood ceiling, before auth (../lib/rate-limit.ts — the RPI MCP
// server's). Behind the web proxy every browser request comes from one address, so
// it is a loose server-wide backstop; the budgets that separate users come after auth.
const limiter = new RateLimiter();
app.use("/api/v1/*", peerFloodLimit(limiter));

// Protected routes
app.use("/api/v1/*", authMiddleware);
// After auth: each caller's request budget; a chat turn (the chat route, the AG-UI
// stream) also spends the caller's turn budget (lib/web-limits.ts; off in dev mode).
app.use("/api/v1/*", userRequestLimit(limiter));
app.on("POST", "/api/v1/workspaces/:workspaceId/chat", turnLimit());
app.on("POST", "/api/v1/workspaces/:workspaceId/threads/:threadId/runs/:runId/stream", turnLimit());
app.route("/api/v1/workspaces", workspaceRoutes);
app.route("/api/v1/workspaces/:workspaceId/threads", threadRoutes);
app.route("/api/v1/workspaces", chatRoutes);
app.route("/api/v1/workspaces", aguiRoutes);
app.route("/api/v1/providers", providerRoutes);
app.route("/api/v1/auth", authRoutes);

app.get("/", (c) => c.redirect("/api/v1/health"));

// A2A inbound server — OFF by default. Gated by env:A2A_ENABLED.
// Dynamic import keeps Express and @a2a-js/sdk out of the runtime when disabled.
if (process.env.A2A_ENABLED === "true") {
  const workspaceId = process.env.A2A_WORKSPACE_ID;
  // Auth mode is explicit (A2A_AUTH_MODE oidc|bearer) — no default, no fallback.
  const { prepareA2AAuth, checkPerUserMcp } = await import("./a2a/auth.js");
  const prepared = await prepareA2AAuth(process.env);
  // oidc forwards each caller's token, so every MCP of the A2A workspace must
  // enforce per-user auth (checkPerUserMcp); otherwise the A2A server is not started.
  let perUser: { ok: true } | { error: string } = { ok: true };
  const checkA2AWorkspaceMcp = async (id: string) => {
    const { db } = await import("./store/db.js");
    const { workspaces } = await import("./store/schema.js");
    const { eq } = await import("drizzle-orm");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    if (!ws) return { error: `A2A workspace "${id}" not found` };
    const config = JSON.parse(ws.config) as { mcp?: Array<{ name: string; transport: string; url?: string }> };
    return checkPerUserMcp(config.mcp ?? []);
  };
  if (!workspaceId) {
    process.stderr.write(
      "[a2a] A2A_ENABLED=true but A2A_WORKSPACE_ID is not set — A2A server not started\n",
    );
  } else if ("error" in prepared) {
    process.stderr.write(`[a2a] ${prepared.error} — A2A server not started\n`);
  } else if (prepared.auth.mode === "oidc" && "error" in (perUser = await checkA2AWorkspaceMcp(workspaceId))) {
    process.stderr.write(`[a2a] ${perUser.error} — A2A server not started\n`);
  } else {
    try {
      const { startA2AServer } = await import("./a2a/index.js");
      const { getSkillRegistry } = await import("./routes/chat.js");
      const skillRegistry = await getSkillRegistry();
      const port = process.env.A2A_PORT
        ? parseInt(process.env.A2A_PORT, 10)
        : undefined;
      const a2a = await startA2AServer({
        skillRegistry,
        workspaceId,
        auth: prepared.auth,
        port,
      });
      process.stderr.write(
        `[a2a] server listening on http://localhost:${a2a.port} (auth: ${prepared.auth.mode})\n`,
      );
    } catch (error) {
      process.stderr.write(
        `[a2a] failed to start: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }
}

// Economic-viability instrumentation — OFF by default. Gated by
// env:INSTRUMENTATION_ENABLED. When unset, no sink is registered, so every
// capture site is a no-op (zero collection, zero writes). Dynamic import keeps
// the fs sink out of the runtime when disabled. See docs/architecture.md
// (cross-cutting subsystems).
if (process.env.INSTRUMENTATION_ENABLED === "true") {
  try {
    const { FileJsonlSink } = await import("./instrumentation/file-sink.js");
    const { configureInstrumentation } = await import("@redpoint-ai/shared");
    const { mkdir } = await import("node:fs/promises");
    // Default to the repo root for dev; containers set INSTRUMENTATION_SINK_PATH to
    // a bind-mounted path (see the bundle compose) so the JSONL lands host-side and
    // survives container recreation — otherwise it writes inside the container and
    // is lost.
    const sinkPath =
      process.env.INSTRUMENTATION_SINK_PATH ??
      join(__serverDir, "../../../instrumentation-events.jsonl");
    // Pre-create the sink directory so the first write can't silently drop events
    // (a missing/unmounted bind-mount dir is the common container failure).
    await mkdir(dirname(sinkPath), { recursive: true });
    configureInstrumentation(new FileJsonlSink(sinkPath));
    process.stderr.write(`[instrumentation] enabled — sink: ${sinkPath}\n`);
  } catch (error) {
    process.stderr.write(
      `[instrumentation] failed to enable: ${error instanceof Error ? error.message : error}\n`,
    );
  }
}

/** The largest request body accepted (413 over it, before it is read); no API call comes near it. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export default {
  port: parseInt(process.env.PORT || "3000"),
  fetch: app.fetch,
  idleTimeout: 255,
  maxRequestBodySize: MAX_BODY_BYTES,
  // Production mode and an unshared port, whatever NODE_ENV says (lib/serve-mode.ts).
  ...SERVE_MODE,
};
