/**
 * The app server's CORS: the web UI's origin only (../cors.ts) — never "*". A page on
 * another site gets no Access-Control-Allow-Origin (so it can't read a response), the
 * web UI's own origin does; the server is wired to this allowlist, not a bare cors().
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Hono } from "hono";
import { LOCAL_WEB_ORIGIN, appCors, corsOrigins } from "../cors.js";

const app = (env: Record<string, string | undefined>) => {
  const a = new Hono();
  a.use("*", appCors(env));
  a.get("/api/v1/health", (c) => c.json({ status: "ok" }));
  return a;
};
const acao = async (env: Record<string, string | undefined>, origin: string, method = "GET") => {
  const headers: Record<string, string> = { Origin: origin };
  if (method === "OPTIONS") headers["Access-Control-Request-Method"] = "POST";
  const res = await app(env).request("/api/v1/health", { method, headers });
  return res.headers.get("access-control-allow-origin");
};

describe("the app server's CORS allowlist", () => {
  it("is the local web UI by default — never \"*\"", () => {
    expect(corsOrigins({})).toEqual([LOCAL_WEB_ORIGIN]);
    expect(corsOrigins({})).not.toContain("*");
  });

  it("adds the web app's public origin from its SSO callback URL (origin only, no path)", () => {
    expect(corsOrigins({ RPI_AI_AGENT_REDIRECT_URL: "https://ai.example.com/api/auth/callback/sso" })).toEqual([LOCAL_WEB_ORIGIN, "https://ai.example.com"]);
    expect(corsOrigins({ RPI_AI_AGENT_REDIRECT_URL: "http://localhost:3001/api/auth/callback/sso" })).toEqual([LOCAL_WEB_ORIGIN]);
    expect(corsOrigins({ RPI_AI_AGENT_REDIRECT_URL: "not a url" })).toEqual([LOCAL_WEB_ORIGIN]);
  });

  it("the web UI's origin is answered; a foreign origin gets NO Access-Control-Allow-Origin", async () => {
    const env = { RPI_AI_AGENT_REDIRECT_URL: "https://ai.example.com/api/auth/callback/sso" };
    expect(await acao(env, LOCAL_WEB_ORIGIN)).toBe(LOCAL_WEB_ORIGIN);
    expect(await acao(env, "https://ai.example.com")).toBe("https://ai.example.com");
    for (const foreign of ["https://evil.example", "http://localhost:3000", "null", "https://ai.example.com.evil.test"]) {
      expect([foreign, await acao(env, foreign)]).toEqual([foreign, null]);
    }
  });

  it("a foreign origin's preflight is not granted either", async () => {
    expect(await acao({}, "https://evil.example", "OPTIONS")).toBeNull();
    expect(await acao({}, LOCAL_WEB_ORIGIN, "OPTIONS")).toBe(LOCAL_WEB_ORIGIN);
  });

  it("the server is wired to this allowlist, not a bare (wildcard) cors()", () => {
    const index = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");
    expect(index).toContain('app.use("*", appCors());');
    expect(index).not.toMatch(/\bcors\(\s*\)/);
    expect(index).not.toContain('from "hono/cors"');
  });
});
