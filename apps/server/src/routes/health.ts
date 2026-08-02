import { Hono } from "hono";
import { APP_VERSION } from "@redpoint-ai/shared";

export const healthRoutes = new Hono();

healthRoutes.get("/health", (c) =>
  c.json({
    status: "ok",
    version: APP_VERSION,
    runtime: "bun",
    timestamp: new Date().toISOString(),
  }),
);
