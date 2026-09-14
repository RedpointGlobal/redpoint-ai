/**
 * #27828 — LLM-driven multi-tenant switching. Exhaustive matrix:
 * resolution (name/id/substring/ambiguous/not-found), the per-conversation +
 * per-user store (persistence-across-turns, isolation-across-conversations,
 * no-cross-USER-bleed), and the switch tool (RBAC up-front reject, ambiguous
 * ASK, success-persists, fail-closed empty list, missing-conversation refuse).
 *
 * HERMETIC (mirrors workspaces.test.ts / integration.test.ts): an OWN in-memory
 * SQLite testDb is mock.module()'d in BEFORE tenant.ts is imported, so these DB
 * tests are order-independent — immune to seed-provider.test.ts mocking db to {}
 * (bun's mock.module leaks across a single-process suite run). They still
 * exercise REAL drizzle delete/insert/select against in-memory SQLite, so
 * persistence / isolation / no-bleed / RBAC-no-write are genuinely validated.
 *
 * The per-request X-ClientID threading in getToolsForWorkspace is covered by the
 * live single-window flow; here we lock the pure logic + the DB store + the
 * tool's server-side RBAC gate.
 */
import { describe, it, expect, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql, eq } from "drizzle-orm";
import * as schema from "../store/schema.js";
import type { AccessibleClient } from "../mcp/tenant.js";

// In-memory db + the one table these tests touch. Created BEFORE the mock so the
// module under test binds to it.
const sqlite = new Database(":memory:");
const testDb = drizzle(sqlite, { schema });
testDb.run(sql`
  CREATE TABLE IF NOT EXISTS conversation_clients (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    client_id       TEXT NOT NULL,
    client_name     TEXT,
    updated_at      INTEGER NOT NULL
  )
`);
mock.module("../store/db.js", () => ({ db: testDb }));

// Import AFTER the mock so tenant.ts's `db` binding is the in-memory testDb.
const {
  resolveTenantSelection,
  getActiveClient,
  setActiveClient,
  createTenantSwitchTool,
} = await import("../mcp/tenant.js");

const WS = "test-ws-27828";
// Genericized fixtures — no real tenant ids/names in the tree.
const CLIENTS: AccessibleClient[] = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Tenant Alpha" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Tenant Beta" },
  { id: "33333333-3333-3333-3333-333333333333", name: "Gamma Corp" },
];

afterAll(() => {
  testDb.delete(schema.conversationClients).run();
});

async function callTool(tool: ReturnType<typeof createTenantSwitchTool>, tenant: string) {
  return (await (tool as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(
    { tenant },
    {},
  )) as string;
}

describe("resolveTenantSelection", () => {
  it("exact id match", () => {
    const r = resolveTenantSelection(CLIENTS, "11111111-1111-1111-1111-111111111111");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.client.name).toBe("Tenant Alpha");
  });

  it("exact name match, case-insensitive", () => {
    const r = resolveTenantSelection(CLIENTS, "gamma corp");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.client.id).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("unique substring match", () => {
    const r = resolveTenantSelection(CLIENTS, "Gamma");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.client.name).toBe("Gamma Corp");
  });

  it("ambiguous substring → ask (never guess)", () => {
    const r = resolveTenantSelection(CLIENTS, "Tenant"); // matches Alpha + Beta, exact-matches neither
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.matches).toHaveLength(2);
  });

  it("not-found → reject", () => {
    expect(resolveTenantSelection(CLIENTS, "Nonexistent").status).toBe("not-found");
  });

  it("empty target → not-found", () => {
    expect(resolveTenantSelection(CLIENTS, "   ").status).toBe("not-found");
  });

  it("exact name wins over a broader substring collision", () => {
    const two: AccessibleClient[] = [
      { id: "1", name: "Prod" },
      { id: "2", name: "Prod-EU" },
    ];
    const r = resolveTenantSelection(two, "Prod"); // exact 'Prod' is unique
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.client.id).toBe("1");
  });
});

describe("per-conversation + per-user store", () => {
  it("persistence-across-turns: set then get (same convo+user)", async () => {
    await setActiveClient("conv-A", "userX", WS, CLIENTS[0]);
    const got = await getActiveClient("conv-A", "userX", WS);
    expect(got?.id).toBe(CLIENTS[0].id);
    expect(got?.name).toBe("Tenant Alpha");
  });

  it("isolation-across-conversations: different chat, same user → no bleed", async () => {
    await setActiveClient("conv-B1", "userY", WS, CLIENTS[0]);
    expect(await getActiveClient("conv-B2", "userY", WS)).toBeUndefined();
  });

  it("no-cross-USER-bleed: same convo id, different user → no bleed", async () => {
    await setActiveClient("conv-shared", "userA", WS, CLIENTS[1]);
    expect(await getActiveClient("conv-shared", "userB", WS)).toBeUndefined();
    expect((await getActiveClient("conv-shared", "userA", WS))?.id).toBe(CLIENTS[1].id);
  });

  it("no row → undefined (falls back to default upstream)", async () => {
    expect(await getActiveClient("conv-never-set", "userZ", WS)).toBeUndefined();
  });

  it("undefined conversationId → undefined (no key)", async () => {
    expect(await getActiveClient(undefined, "userZ", WS)).toBeUndefined();
  });

  it("switch again overwrites (one row, latest wins)", async () => {
    await setActiveClient("conv-C", "userX", WS, CLIENTS[0]);
    await setActiveClient("conv-C", "userX", WS, CLIENTS[2]);
    const got = await getActiveClient("conv-C", "userX", WS);
    expect(got?.id).toBe(CLIENTS[2].id);
    const rows = await testDb
      .select()
      .from(schema.conversationClients)
      .where(eq(schema.conversationClients.conversationId, "conv-C"));
    expect(rows).toHaveLength(1); // no accumulation
  });
});

describe("set_active_tenant tool — server-side RBAC gate", () => {
  const deps = (conversationId: string | undefined, clients: AccessibleClient[]) => ({
    conversationId,
    userId: "toolUser",
    workspaceId: WS,
    listClients: () => Promise.resolve(clients),
  });

  it("valid target → persists + confirms", async () => {
    const t = createTenantSwitchTool(deps("conv-tool-1", CLIENTS));
    const msg = await callTool(t, "Tenant Alpha");
    expect(msg).toContain("Switched");
    expect(msg).toContain("Tenant Alpha");
    // Compound-turn tuning: the result must tell the model NOT to re-thread the
    // tenant (else it name→resolve→401s on "switch to X and <op>").
    expect(msg).toMatch(/do NOT pass the tenant name or a clientId/i);
    expect((await getActiveClient("conv-tool-1", "toolUser", WS))?.id).toBe(CLIENTS[0].id);
  });

  it("Option B: success fires onSwitch with the new clientId (mid-turn apply)", async () => {
    // The in-request holder chat.ts threads into the MCP wrappers; onSwitch must
    // update it so subsequent same-turn RPI calls target the switched tenant.
    const switched: string[] = [];
    const t = createTenantSwitchTool({
      ...deps("conv-tool-onswitch", CLIENTS),
      onSwitch: (id) => switched.push(id),
    });
    await callTool(t, "Gamma Corp");
    expect(switched).toEqual([CLIENTS[2].id]);
  });

  it("Option B: a REJECTED switch does NOT fire onSwitch (no mid-turn repoint)", async () => {
    const switched: string[] = [];
    const t = createTenantSwitchTool({
      ...deps("conv-tool-onswitch-reject", CLIENTS),
      onSwitch: (id) => switched.push(id),
    });
    await callTool(t, "Nonexistent Tenant"); // not-found → reject
    await callTool(t, "Tenant"); // ambiguous → ask
    expect(switched).toEqual([]);
  });

  it("RBAC reject: inaccessible target → up-front reject, NO write", async () => {
    const t = createTenantSwitchTool(deps("conv-tool-2", CLIENTS));
    const msg = await callTool(t, "Some Other Tenant");
    expect(msg.toLowerCase()).toContain("isn't one of the tenants you can access");
    expect(await getActiveClient("conv-tool-2", "toolUser", WS)).toBeUndefined();
  });

  it("ambiguous → ASK, NO write", async () => {
    const t = createTenantSwitchTool(deps("conv-tool-3", CLIENTS));
    const msg = await callTool(t, "Tenant");
    expect(msg).toContain("more than one");
    expect(await getActiveClient("conv-tool-3", "toolUser", WS)).toBeUndefined();
  });

  it("fail-closed: empty accessible list → reject, NO write", async () => {
    const t = createTenantSwitchTool(deps("conv-tool-4", []));
    const msg = await callTool(t, "Tenant Alpha");
    expect(msg.toLowerCase()).toContain("couldn't retrieve");
    expect(await getActiveClient("conv-tool-4", "toolUser", WS)).toBeUndefined();
  });

  it("missing conversationId → graceful refuse, NO global write", async () => {
    const t = createTenantSwitchTool(deps(undefined, CLIENTS));
    const msg = await callTool(t, "Tenant Alpha");
    expect(msg.toLowerCase()).toContain("no conversation id");
  });
});
