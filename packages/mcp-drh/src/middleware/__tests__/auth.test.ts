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

describe("createDrhAuthMiddleware with the token check (pinned token mode)", () => {
  type Result = "valid" | "invalid" | "unavailable" | "refused";
  function checkedApp(result: Result, opts: { joined?: boolean } = {}) {
    const seen = { checks: [] as Array<{ token: string; tenant: string }>, admits: 0, failures: 0 };
    const auth = {
      checkToken: async (token: string, tenant: string, admit?: () => { ok: boolean }) => {
        seen.checks.push({ token, tenant });
        if (!opts.joined) admit?.();
        return result === "refused" ? { result, retryAfterSec: 9 } : { result };
      },
    };
    const budgets = {
      admit: () => (seen.admits++, { ok: true as const, settle: () => {} }),
      failed: () => void seen.failures++,
    };
    const app = new Hono();
    app.use("/mcp", createDrhAuthMiddleware(true, { auth: auth as never, tenant: "t-pinned", budgets }));
    app.all("/mcp", (c) => c.json({ authInfo: c.get("authInfo") ?? null, callerKey: c.get("callerKey") ?? null }));
    const call = (token = "tok-1") => app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    return { seen, call };
  }

  it("valid → admitted, checked against the pinned tenant; callerKey is a hash of the token", async () => {
    const { seen, call } = checkedApp("valid");
    const res = await call("tok-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authInfo: { token: string }; callerKey: string };
    expect(body.authInfo.token).toBe("tok-1");
    expect(body.callerKey).toMatch(/^token:[0-9a-f]{64}$/);
    expect(body.callerKey).not.toContain("tok-1");
    expect(seen.checks).toEqual([{ token: "tok-1", tenant: "t-pinned" }]);
  });

  it("invalid → 401; the next handler never runs; a failure it asked DRH for is counted by the admission, not twice", async () => {
    const { seen, call } = checkedApp("invalid");
    expect((await call()).status).toBe(401);
    expect(seen.failures).toBe(0);
  });

  it("invalid on an answer it did not ask DRH for (cached / joined) → 401 and one failure counted", async () => {
    const { seen, call } = checkedApp("invalid", { joined: true });
    expect((await call()).status).toBe(401);
    expect(seen.failures).toBe(1);
  });

  it("DRH unavailable → 401, never counted as the caller's failure", async () => {
    const { seen, call } = checkedApp("unavailable", { joined: true });
    expect((await call()).status).toBe(401);
    expect(seen.failures).toBe(0);
  });

  it("refused by a budget → 429 with Retry-After", async () => {
    const { call } = checkedApp("refused");
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
  });

  it("no token → 401 before any check", async () => {
    const { seen } = checkedApp("valid");
    const app = new Hono();
    app.use("/mcp", createDrhAuthMiddleware(true, { auth: { checkToken: async () => ({ result: "valid" as const }) } as never, tenant: "t", budgets: { admit: () => ({ ok: true as const, settle: () => {} }), failed: () => {} } }));
    app.all("/mcp", (c) => c.json({}));
    expect((await app.request("/mcp", { method: "POST" })).status).toBe(401);
    expect(seen.checks.length).toBe(0);
  });
});
