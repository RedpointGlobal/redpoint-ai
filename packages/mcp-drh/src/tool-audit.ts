/**
 * One structured audit line per tool call, to stderr:
 *   [mcp-drh] audit {"ts":…,"principal":…,"tool":…,"tenant":…,"outcome":…,"durationMs":…,"argKeys":[…]}
 * The principal is who the call ran as: a hash of the caller's token (never the
 * token) when the call carries one; else the configured native DRH account the
 * call falls back to (`drh-native:<user>` — the username only, never the password);
 * else "anonymous" (no token and no account: the call can only fail). The
 * arguments are NAMES only (never values); the tenant is the call's clientId,
 * when set. Outcomes: "ok" and "error" (an isError result or a thrown error).
 *
 * The wiring: installToolAudit() wraps each registered tool's handler
 * through the SDK's public `update({ callback })`, outermost, so it sees every call
 * that reaches a handler (calls rejected by the SDK's own argument validation never
 * reach a handler and are not logged). Credit: the wrapping approach follows the
 * DRH security audit's installToolAudit.
 */
import { createHash } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function principalHash(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "anonymous";
}

/** The native DRH account a token-less call runs as (the proxy user), set once at boot. */
let nativeAccount: string | null = null;
export function setAuditAccount(user: string | null | undefined): void {
  nativeAccount = user ? user : null;
}

/** Who a call ran as (see the header). */
export function auditPrincipal(token: string | undefined): string {
  if (token) return principalHash(token);
  return nativeAccount ? `drh-native:${nativeAccount}` : "anonymous";
}

export function auditLine(e: {
  token: string | undefined;
  tool: string;
  args: unknown;
  outcome: "ok" | "error";
  durationMs: number;
}): string {
  const args = e.args && typeof e.args === "object" ? (e.args as Record<string, unknown>) : {};
  const tenant = typeof args.clientId === "string" && args.clientId ? args.clientId : null;
  return `[mcp-drh] audit ${JSON.stringify({
    ts: new Date().toISOString(),
    principal: auditPrincipal(e.token),
    tool: e.tool,
    tenant,
    outcome: e.outcome,
    durationMs: e.durationMs,
    argKeys: Object.keys(args).filter((k) => k !== "clientId").sort(),
  })}`;
}

type Handler = (...params: unknown[]) => unknown;

interface AuditableTool {
  handler: unknown;
  update(updates: { callback: Handler }): void;
}

/**
 * Wrap every registered tool's handler so each call emits one audit line. Install
 * once, after all tools are registered (createDrhMcpServer). The SDK calls
 * handler(args, extra) for a tool with an input schema and handler(extra) for one
 * without — everything is passed through unchanged.
 */
export function installToolAudit(server: McpServer): void {
  const registered = (
    server as unknown as { _registeredTools: Record<string, AuditableTool> }
  )._registeredTools;

  for (const [name, tool] of Object.entries(registered)) {
    const inner = tool.handler;
    if (typeof inner !== "function") continue;

    tool.update({
      callback: async (...params: unknown[]) => {
        const extra = params[params.length - 1] as { authInfo?: { token?: unknown } } | undefined;
        const args = (params.length > 1 ? params[0] : undefined) as Record<string, unknown> | undefined;
        const token = typeof extra?.authInfo?.token === "string" ? extra.authInfo.token : undefined;
        const started = performance.now(); // monotonic: the wall clock can step
        let outcome: "ok" | "error" = "error";
        try {
          const result = await (inner as Handler)(...params);
          outcome = (result as { isError?: boolean } | undefined)?.isError ? "error" : "ok";
          return result;
        } finally {
          console.error(auditLine({ token, tool: name, args, outcome, durationMs: Math.round(performance.now() - started) }));
        }
      },
    });
  }
}
