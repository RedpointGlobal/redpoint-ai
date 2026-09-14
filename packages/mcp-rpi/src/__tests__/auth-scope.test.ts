import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveToolAuth,
  scopeOf,
  ScopeAuthError,
  classifyToolError,
  handleScopeAuthError,
  initAuthScope,
  ADMIN_TOOLS,
  isAdminEndpoint,
} from "../auth-scope.js";
import type { RPIAuthService } from "../client/rpi-auth.js";
import { RpiApiError } from "../client/rpi-api.js";
import { createRPIMcpServer } from "../server.js";
import type { RPIConfig } from "../config.js";

const stubAuth = {
  getProxyToken: async () => "PROXY_TOKEN",
} as unknown as RPIAuthService;

// ---------------------------------------------------------------------------
// scopeOf — static classification
// ---------------------------------------------------------------------------
describe("auth-scope · scopeOf", () => {
  it("admin-scoped: /cluster tools", () => {
    expect(scopeOf("list_clients")).toBe("admin");
    expect(scopeOf("get_client_by_id")).toBe("admin");
    expect(scopeOf("get_system_health_availability")).toBe("admin");
    expect(scopeOf("list_cluster_users")).toBe("admin");
    expect(scopeOf("get_cluster_audit_history")).toBe("admin");
  });
  it("user-scoped (default): resource tools, the relabel target, client-scoped health, and unknown tools", () => {
    expect(scopeOf("get_user_client_list")).toBe("user"); // relabel target — must be user
    expect(scopeOf("list_audiences")).toBe("user");
    expect(scopeOf("list_selection_rules")).toBe("user");
    expect(scopeOf("get_system_health_monitoring_overview")).toBe("user"); // /client scope, NOT /cluster
    expect(scopeOf("a_brand_new_untagged_tool")).toBe("user"); // fail-safe default
  });
});

// ---------------------------------------------------------------------------
// resolveToolAuth — the fail-closed guarantee, combinatorially
//   (AUTH_REQUIRED) × (scope) × (userToken present/absent)
// ---------------------------------------------------------------------------
describe("auth-scope · resolveToolAuth (combinatorial)", () => {
  let saved: string | undefined;
  const setAuth = (v: string | undefined) => {
    if (v === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = v;
  };
  beforeEach(() => {
    saved = process.env.AUTH_REQUIRED;
    initAuthScope(stubAuth);
  });
  afterEach(() => setAuth(saved));

  // AUTH_REQUIRED=false → proxy for everything (dev/loose, unchanged)
  it("auth=false · user tool · no token → proxy", async () => {
    setAuth("false");
    expect(await resolveToolAuth("list_audiences", undefined)).toBe("PROXY_TOKEN");
  });
  it("auth=false · admin tool · no token → proxy", async () => {
    setAuth("false");
    expect(await resolveToolAuth("list_clients", undefined)).toBe("PROXY_TOKEN");
  });
  it("auth=false · user tool · token → that token", async () => {
    setAuth("false");
    expect(await resolveToolAuth("list_audiences", "U")).toBe("U");
  });

  // AUTH_REQUIRED=true → per-user, fail-closed
  it("auth=true · user tool · token → user token", async () => {
    setAuth("true");
    expect(await resolveToolAuth("list_audiences", "U")).toBe("U");
  });
  it("auth=true · admin tool · token → user token (RPI enforces role)", async () => {
    setAuth("true");
    expect(await resolveToolAuth("list_clients", "U")).toBe("U");
  });
  it("auth=true · admin tool · no token → proxy (genuine system/no-user op)", async () => {
    setAuth("true");
    expect(await resolveToolAuth("list_clients", undefined)).toBe("PROXY_TOKEN");
  });
  it("auth=true · USER tool · no token → FAIL CLOSED (throws, NEVER proxy)", async () => {
    setAuth("true");
    await expect(
      resolveToolAuth("list_audiences", undefined),
    ).rejects.toBeInstanceOf(ScopeAuthError);
  });
  it("auth unset (secure default = true) · user tool · no token → FAIL CLOSED", async () => {
    setAuth(undefined);
    await expect(
      resolveToolAuth("list_audiences", undefined),
    ).rejects.toBeInstanceOf(ScopeAuthError);
  });
  it("auth=true · UNTAGGED tool · no token → FAIL CLOSED (default user)", async () => {
    setAuth("true");
    await expect(
      resolveToolAuth("brand_new_tool", undefined),
    ).rejects.toBeInstanceOf(ScopeAuthError);
  });
});

// ---------------------------------------------------------------------------
// classifyToolError — clean, role-appropriate, no raw status/body
// ---------------------------------------------------------------------------
describe("auth-scope · classifyToolError", () => {
  it("401 → session/sign-in message", () => {
    const r = classifyToolError(new RpiApiError(401, "boom"), "list_audiences");
    expect(r?.isError).toBe(true);
    expect(r?.content[0].text).toMatch(/sign in/i);
    expect(r?.content[0].text).not.toMatch(/boom/); // no raw body/detail
  });
  it("403 · admin tool → 'not available for your role'", () => {
    const r = classifyToolError(new RpiApiError(403, "boom"), "list_clients");
    expect(r?.content[0].text).toMatch(/not available for your role/i);
  });
  it("403 · user tool → 'not authorized'", () => {
    const r = classifyToolError(new RpiApiError(403, "boom"), "list_audiences");
    expect(r?.content[0].text).toMatch(/not authorized/i);
  });
  it("500 → null (rethrow, not softened)", () => {
    expect(classifyToolError(new RpiApiError(500, "boom"), "list_audiences")).toBeNull();
  });
  it("non-status error → null", () => {
    expect(classifyToolError(new Error("boom"), "list_audiences")).toBeNull();
  });
});

describe("auth-scope · handleScopeAuthError", () => {
  it("returns a clean auth-required message with no internal detail", () => {
    const r = handleScopeAuthError(new ScopeAuthError("list_audiences"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
    expect(r.content[0].text).not.toMatch(/proxy|fail-closed/i);
  });
});

// ---------------------------------------------------------------------------
// Drift-guard — the static ADMIN_TOOLS set must cover EVERY registered tool
// whose RPI endpoint is under /cluster, and carry no stale entries.
// ---------------------------------------------------------------------------
describe("auth-scope · drift-guard (ADMIN_TOOLS covers all /cluster tools)", () => {
  it("no /cluster tool is left untagged, and no admin entry is stale", () => {
    const cfg = {
      integrationApiUrl: "http://localhost:9",
      defaultClientId: "test",
    } as unknown as RPIConfig;
    // instanceEndpoints=null → fail-open → the FULL compiled-in tool superset
    // stays registered, exactly what the drift-guard must audit.
    const { server } = createRPIMcpServer(cfg, stubAuth, null, null);
    const registered = (
      server as unknown as {
        _registeredTools: Record<string, { _meta?: { endpoints?: string[] } }>;
      }
    )._registeredTools;

    const untaggedCluster: string[] = [];
    for (const [name, tool] of Object.entries(registered)) {
      const eps = tool._meta?.endpoints ?? [];
      if (eps.some(isAdminEndpoint) && !ADMIN_TOOLS.has(name)) {
        untaggedCluster.push(name);
      }
    }
    expect(untaggedCluster).toEqual([]);

    const registeredNames = new Set(Object.keys(registered));
    const stale = [...ADMIN_TOOLS].filter((n) => !registeredNames.has(n));
    expect(stale).toEqual([]);
  });
});
