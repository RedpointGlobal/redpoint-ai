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

// Refuse to boot in auth-required mode without a real AUTH_SECRET. The
// docker-compose default is `changeme-...` precisely so an operator who
// flips AUTH_REQUIRED=true without configuring the secret fails loud here
// instead of silently signing JWTs with a public string.
if (process.env.AUTH_REQUIRED === "true") {
  const secret = process.env.AUTH_SECRET ?? "";
  if (!secret || secret.startsWith("changeme-")) {
    console.error(
      "[fatal] AUTH_REQUIRED=true but AUTH_SECRET is missing or still set to the changeme-* placeholder. " +
        "Generate one with `openssl rand -base64 32` and set it in .env (or as an env var) before starting in auth-required mode.",
    );
    process.exit(1);
  }
}

import { Hono } from "hono";
import { cors } from "hono/cors";
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

await seedDefaults();

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

// Public routes (no auth required)
app.route("/api/v1", healthRoutes);
app.route("/metrics", metricsRoutes);

// Protected routes
app.use("/api/v1/*", authMiddleware);
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
  const bearerToken = process.env.A2A_BEARER_TOKEN;
  if (!workspaceId || !bearerToken) {
    process.stderr.write(
      "[a2a] A2A_ENABLED=true but A2A_WORKSPACE_ID or A2A_BEARER_TOKEN is not set — A2A server not started\n",
    );
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
        bearerToken,
        port,
      });
      process.stderr.write(
        `[a2a] server listening on http://localhost:${a2a.port}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `[a2a] failed to start: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }
}

export default {
  port: parseInt(process.env.PORT || "3000"),
  fetch: app.fetch,
  idleTimeout: 255,
};
