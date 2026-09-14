/**
 * MCP OAuth resource-server metadata (Mechanism A) — RFC 9728 PRM shape, the
 * WWW-Authenticate challenge, request-derived origin, and that 401s carry the
 * challenge exactly when discovery is enabled (and not otherwise).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import {
  serverOrigin,
  mcpResourceUrl,
  protectedResourceMetadataUrl,
  buildProtectedResourceMetadata,
  wwwAuthenticateChallenge,
  DEFAULT_MCP_SCOPES,
} from "../oauth-metadata.js";
import { createRpiAuthMiddleware } from "../middleware/auth.js";
import type { RPIAuthService } from "../client/rpi-auth.js";

const origPublic = process.env.RPI_MCP_PUBLIC_URL;
afterEach(() => {
  if (origPublic === undefined) delete process.env.RPI_MCP_PUBLIC_URL;
  else process.env.RPI_MCP_PUBLIC_URL = origPublic;
});

function metaApp() {
  const app = new Hono();
  app.get("/meta", (c) =>
    c.json({
      origin: serverOrigin(c.req),
      resource: mcpResourceUrl(c.req),
      prm: protectedResourceMetadataUrl(c.req),
      doc: buildProtectedResourceMetadata(c.req, "https://kc.example/realms/r"),
      challenge: wwwAuthenticateChallenge(c.req),
    }),
  );
  return app;
}

describe("oauth-metadata helpers", () => {
  it("derives origin/resource/PRM url from the Host header", async () => {
    delete process.env.RPI_MCP_PUBLIC_URL;
    const res = await metaApp().request("/meta", { headers: { host: "mcp.example.com" } });
    const b = (await res.json()) as Record<string, string>;
    expect(b.origin).toBe("http://mcp.example.com");
    expect(b.resource).toBe("http://mcp.example.com/mcp");
    expect(b.prm).toBe(
      "http://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("honors X-Forwarded-Proto (behind a TLS proxy)", async () => {
    delete process.env.RPI_MCP_PUBLIC_URL;
    const res = await metaApp().request("/meta", {
      headers: { host: "mcp.example.com", "x-forwarded-proto": "https" },
    });
    const b = (await res.json()) as Record<string, string>;
    expect(b.origin).toBe("https://mcp.example.com");
    expect(b.resource).toBe("https://mcp.example.com/mcp");
  });

  it("RPI_MCP_PUBLIC_URL overrides the derived origin", async () => {
    process.env.RPI_MCP_PUBLIC_URL = "https://public.mcp.example/";
    const res = await metaApp().request("/meta", { headers: { host: "internal:3002" } });
    const b = (await res.json()) as Record<string, string>;
    expect(b.origin).toBe("https://public.mcp.example");
    expect(b.resource).toBe("https://public.mcp.example/mcp");
  });

  it("PRM document has the RFC 9728 shape", async () => {
    delete process.env.RPI_MCP_PUBLIC_URL;
    const res = await metaApp().request("/meta", { headers: { host: "mcp.example.com" } });
    const b = (await res.json()) as { doc: Record<string, unknown> };
    expect(b.doc.resource).toBe("http://mcp.example.com/mcp");
    expect(b.doc.authorization_servers).toEqual(["https://kc.example/realms/r"]);
    expect(b.doc.scopes_supported).toEqual(DEFAULT_MCP_SCOPES);
    expect(b.doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("WWW-Authenticate challenge points at the PRM url + scope", async () => {
    delete process.env.RPI_MCP_PUBLIC_URL;
    const res = await metaApp().request("/meta", { headers: { host: "mcp.example.com" } });
    const b = (await res.json()) as { challenge: string };
    expect(b.challenge).toBe(
      'Bearer resource_metadata="http://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="openid profile email offline_access"',
    );
  });
});

function authApp(discoveryEnabled: boolean) {
  const fakeAuth = {
    validateToken: async (t: string) => t === "goodtoken",
  } as unknown as RPIAuthService;
  const app = new Hono();
  app.use("*", createRpiAuthMiddleware(fakeAuth, true, null, discoveryEnabled));
  app.get("/mcp", (c) => c.json({ ok: true }));
  return app;
}

describe("auth middleware — WWW-Authenticate on 401 (Mechanism A)", () => {
  it("no token + discovery ON → 401 WITH WWW-Authenticate → PRM", async () => {
    const res = await authApp(true).request("/mcp", { headers: { host: "m.example" } });
    expect(res.status).toBe(401);
    const wa = res.headers.get("WWW-Authenticate");
    expect(wa).toContain(
      'resource_metadata="http://m.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(wa).toContain('scope="openid');
  });

  it("invalid token + discovery ON → 401 WITH WWW-Authenticate (mid-session re-discover)", async () => {
    const res = await authApp(true).request("/mcp", {
      headers: { Authorization: "Bearer badtoken", host: "m.example" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  it("no token + discovery OFF → 401 WITHOUT WWW-Authenticate (unchanged legacy behavior)", async () => {
    const res = await authApp(false).request("/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("valid token → 200, no challenge", async () => {
    const res = await authApp(true).request("/mcp", {
      headers: { Authorization: "Bearer goodtoken" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});
