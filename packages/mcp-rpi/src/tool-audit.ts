/**
 * One structured audit line per tool call, to stderr:
 *   [mcp-rpi] audit {"ts":…,"principal":…,"tool":…,"tenant":…,"outcome":…,"durationMs":…,"argKeys":[…]}
 * The principal is who the call ran as: a hash of the caller's token (never the
 * token) when the call carries one; else the configured native RPI account the
 * call falls back to (`rpi-native:<user>`, the form a downstream consumer's own logs
 * can join on; the username only, never the password); else
 * "anonymous" (no token and no account: the call can only fail). The arguments
 * are NAMES only (never values); the tenant is the call's clientId, when set — on a
 * pinned server (./tenant-pin.ts) always the pinned tenant, the one every call runs in.
 * Outcomes: "ok", "error" (an isError result or a thrown error), "denied" (the
 * auth scope refused the call).
 */
import { createHash } from "crypto";

export function principalHash(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "anonymous";
}

/** The native RPI account a token-less call runs as (the proxy user), set once at boot. */
let nativeAccount: string | null = null;
export function setAuditAccount(user: string | null | undefined): void {
  nativeAccount = user ? user : null;
}

/** The tenant a pinned server runs every call in, set once at boot; null when not pinned. */
let pinnedTenant: string | null = null;
export function setAuditTenant(tenant: string | null | undefined): void {
  pinnedTenant = tenant ? tenant : null;
}

/** Who a call ran as (see the header). */
export function auditPrincipal(token: string | undefined): string {
  if (token) return principalHash(token);
  return nativeAccount ? `rpi-native:${nativeAccount}` : "anonymous";
}

export function auditLine(e: {
  token: string | undefined;
  tool: string;
  args: unknown;
  outcome: "ok" | "error" | "denied";
  durationMs: number;
}): string {
  const args = e.args && typeof e.args === "object" ? (e.args as Record<string, unknown>) : {};
  const tenant = pinnedTenant ?? (typeof args.clientId === "string" && args.clientId ? args.clientId : null);
  return `[mcp-rpi] audit ${JSON.stringify({
    ts: new Date().toISOString(),
    principal: auditPrincipal(e.token),
    tool: e.tool,
    tenant,
    outcome: e.outcome,
    durationMs: e.durationMs,
    argKeys: Object.keys(args).filter((k) => k !== "clientId").sort(),
  })}`;
}
