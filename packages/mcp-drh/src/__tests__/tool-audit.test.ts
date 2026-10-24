/**
 * One structured stderr audit line per DRH tool call: a hashed principal (never
 * the token), the tool, the tenant, the outcome, the duration, argument NAMES
 * only. The wiring is installToolAudit (the SDK update-wrapper); the principal
 * rule is the native-account fallback (drh-native:<user>).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installToolAudit, principalHash, setAuditAccount } from "../tool-audit.js";

const realError = console.error;
let lines: string[] = [];
afterEach(() => {
  console.error = realError;
  lines = [];
  setAuditAccount(null);
});
const capture = () => void (console.error = (...a: unknown[]) => void lines.push(a.join(" ")));
const audits = () => lines.filter((l) => l.startsWith("[mcp-drh] audit ")).map((l) => JSON.parse(l.slice("[mcp-drh] audit ".length)));

async function call(server: McpServer, name: string, args: Record<string, unknown>, token: string | null = "user-secret-token") {
  const handler = (server.server as unknown as { _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<unknown>> })._requestHandlers.get("tools/call")!;
  return handler(
    { method: "tools/call", params: { name, arguments: args } },
    { signal: new AbortController().signal, sendRequest: () => Promise.resolve({}), authInfo: token === null ? undefined : { token, clientId: "t", scopes: [] } },
  );
}

function harness() {
  const server = new McpServer({ name: "t", version: "0" });
  const schema = { clientId: z.string().optional(), search: z.string().optional(), fail: z.enum(["no", "result", "throw"]).optional() };
  server.registerTool("drh_verify_connection", { description: "x", inputSchema: schema }, async ({ fail }: { fail?: string }) => {
    if (fail === "throw") throw new Error("boom");
    return { content: [{ type: "text", text: "ok" }], ...(fail === "result" ? { isError: true } : {}) };
  });
  installToolAudit(server); // wire audit AFTER registration, as createDrhMcpServer does
  return server;
}

describe("the DRH tool audit line", () => {
  it("ok: principal hashed, tenant from clientId, argument names only — no values, no token", async () => {
    capture();
    await call(harness(), "drh_verify_connection", { clientId: "tenant-9", search: "PII-value" });
    const [a] = audits();
    expect(a).toMatchObject({ principal: principalHash("user-secret-token"), tool: "drh_verify_connection", tenant: "tenant-9", outcome: "ok", argKeys: ["search"] });
    expect(typeof a.durationMs).toBe("number");
    const raw = lines.join("\n");
    expect(raw).not.toContain("PII-value");
    expect(raw).not.toContain("user-secret-token");
    expect(principalHash("user-secret-token")).toMatch(/^[0-9a-f]{16}$/);
  });
  it("an isError result or a throw → outcome error", async () => {
    capture();
    const s = harness();
    await call(s, "drh_verify_connection", { fail: "result" });
    await call(s, "drh_verify_connection", { fail: "throw" }).catch(() => {});
    expect(audits().map((a) => [a.outcome, a.tenant])).toEqual([["error", null], ["error", null]]);
  });
  it("a token-less call with a native account (env-credential mode) → principal drh-native:<user>; no secret in the line", async () => {
    setAuditAccount("svc-account");
    capture();
    await call(harness(), "drh_verify_connection", { search: "x" }, null).catch(() => {});
    const [a] = audits();
    expect(a.principal).toBe("drh-native:svc-account");
    expect(lines.join("\n")).not.toMatch(/pass|secret/i);
  });
  it("a call WITH a token keeps the token hash even when a native account is set (token mode unchanged)", async () => {
    setAuditAccount("svc-account");
    capture();
    await call(harness(), "drh_verify_connection", {});
    expect(audits()[0].principal).toBe(principalHash("user-secret-token"));
  });
  it("no token and no account → anonymous", async () => {
    capture();
    await call(harness(), "drh_verify_connection", {}, null).catch(() => {});
    expect(audits()[0].principal).toBe("anonymous");
  });
});
