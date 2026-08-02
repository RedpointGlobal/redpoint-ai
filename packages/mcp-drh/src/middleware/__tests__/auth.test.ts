import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createDrhAuthMiddleware } from "../auth.js";

/** Mount the middleware on a probe route that echoes the resolved authInfo. */
function appWith(authRequired: boolean) {
  const app = new Hono();
  app.use("/mcp", createDrhAuthMiddleware(authRequired));
  app.all("/mcp", (c) =>
    c.json({ authInfo: c.get("authInfo") ?? null }),
  );
  return app;
}

describe("createDrhAuthMiddleware", () => {
  it("auth OFF → passes through with authInfo undefined (no token needed)", async () => {
    const res = await appWith(false).request("/mcp", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authInfo: null });
  });

  it("auth ON + no Authorization header → 401", async () => {
    const res = await appWith(true).request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("auth ON + non-Bearer header → 401", async () => {
    const res = await appWith(true).request("/mcp", {
      method: "POST",
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("auth ON + empty bearer token → 401", async () => {
    const res = await appWith(true).request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer   " },
    });
    expect(res.status).toBe(401);
  });

  it("auth ON + Bearer token → passes, authInfo carries the forwarded token", async () => {
    const res = await appWith(true).request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer tok-123" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authInfo: { token: "tok-123", clientId: "drh-user", scopes: [] },
    });
  });
});
