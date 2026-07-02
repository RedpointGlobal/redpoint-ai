import { Hono } from "hono";
import { register, Counter, Histogram, Gauge } from "prom-client";

export const runsTotal = new Counter({
  name: "redpoint_ai_runs_total",
  help: "Total completed runs",
  labelNames: ["status", "provider"] as const,
});

export const tokensTotal = new Counter({
  name: "redpoint_ai_tokens_total",
  help: "Total tokens consumed",
  labelNames: ["type"] as const,
});

export const runDuration = new Histogram({
  name: "redpoint_ai_run_duration_seconds",
  help: "Run duration in seconds",
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
});

export const mcpCalls = new Counter({
  name: "redpoint_ai_mcp_calls_total",
  help: "Total MCP tool calls",
  labelNames: ["server", "tool"] as const,
});

export const activeSessions = new Gauge({
  name: "redpoint_ai_active_sessions",
  help: "Currently active chat sessions",
});

export const hallucinationsTotal = new Counter({
  name: "redpoint_ai_hallucinations_total",
  help: "LLM responses that claimed an action without calling a tool",
  labelNames: ["provider"] as const,
});

export const metricsRoutes = new Hono();

metricsRoutes.get("/", async (c) => {
  c.header("Content-Type", register.contentType);
  return c.body(await register.metrics());
});
