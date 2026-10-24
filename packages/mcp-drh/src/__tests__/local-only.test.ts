/**
 * The local-only rule (../local-only.ts) for env-credential mode: which Origin and
 * Host values pass. The allowed set is what native clients and local pages send
 * (measured: no Origin from Claude Code, mcp-remote, the MCP SDK, curl; a loopback
 * Origin from a local page such as the MCP Inspector); everything else is refused,
 * including "null", a malformed value and a DNS-rebinding Host.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { hostAllowed, localOnly, originAllowed } from "../local-only.js";
import { HOSTS, ORIGINS } from "./local-only-matrix.js";

describe("the Origin rule", () => {
  for (const [origin, ok] of ORIGINS) it(`${JSON.stringify(origin)} → ${ok ? "allowed" : "refused"}`, () => expect(originAllowed(origin)).toBe(ok));
});

describe("the Host rule", () => {
  for (const [host, ok] of HOSTS) it(`${JSON.stringify(host)} → ${ok ? "allowed" : "refused"}`, () => expect(hostAllowed(host)).toBe(ok));
});

describe("the middleware (before CORS, as http.ts mounts it)", () => {
  const app = new Hono();
  app.use("/*", localOnly());
  app.use("/*", cors({ origin: "*" }));
  app.all("/mcp", (c) => c.json({ ok: true }));
  const call = (headers: Record<string, string>, method = "POST") => app.request("http://localhost/mcp", { method, headers });

  it("a native client (no Origin, loopback Host) passes", async () => {
    expect((await call({ host: "localhost:3003" })).status).toBe(200);
  });
  it("a local page passes", async () => {
    expect((await call({ host: "127.0.0.1:3003", origin: "http://localhost:6274" })).status).toBe(200);
  });
  it("a page from another site is refused, by name — including its CORS preflight", async () => {
    const res = await call({ host: "localhost:3003", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/a web page from another site may not call this server/);
    const preflight = await call({ host: "localhost:3003", origin: "https://evil.example", "access-control-request-method": "POST" }, "OPTIONS");
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
  it('the "null" Origin and a malformed one are refused', async () => {
    expect((await call({ host: "localhost:3003", origin: "null" })).status).toBe(403);
    expect((await call({ host: "localhost:3003", origin: "not a url" })).status).toBe(403);
  });
  it("a DNS-rebinding Host is refused, with or without an Origin", async () => {
    const res = await call({ host: "evil.example:3003" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/the Host must be localhost/);
    expect((await call({ host: "evil.example:3003", origin: "http://evil.example:3003" })).status).toBe(403);
  });
});
