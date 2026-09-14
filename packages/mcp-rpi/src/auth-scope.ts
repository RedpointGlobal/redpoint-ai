/**
 * Per-tool auth scoping — the single, declarative identity decision for every
 * RPI tool call. REPLACES the old `userToken ?? proxyToken` fallback that lived
 * in rpi-api.ts (which silently escalated a missing user token to the shared
 * admin/proxy account — the "silent-admin" hole).
 *
 * Model:
 *   - Each tool has a static scope: "user" (default) or "admin". Untagged/new
 *     tools default to "user" so they fail SAFE, never as admin.
 *   - `resolveToolAuth` is the ONE place that decides which token a call runs
 *     under, keyed on (AUTH_REQUIRED, scope, userToken present, proxy):
 *       AUTH_REQUIRED=false      → proxy for everything (dev/loose, unchanged).
 *       AUTH_REQUIRED=true:
 *         user token present      → run as the user (RPI enforces their real
 *                                   role — this covers BOTH user and admin
 *                                   tools; an admin tool run by a non-admin
 *                                   simply 403s at RPI, handled gracefully).
 *         no user token, admin    → proxy (genuine no-user system/background op).
 *         no user token, user     → THROW (fail-closed; never proxy).
 *
 * The admin set below is a dumb static list. A drift-guard test asserts every
 * tool whose RPI endpoint is under /cluster or the cluster system-health check
 * appears here, so the list can't silently rot as tools are added.
 */
import type { RPIAuthService } from "./client/rpi-auth.js";

/**
 * Admin-scoped tools: those whose RPI endpoint is under `/cluster/...` (the
 * cluster directory / operations / logs / configuration) — cluster-admin
 * surface. Everything else defaults to "user".
 *
 * NOTE: `get_system_health_monitoring_overview` is deliberately NOT here — it
 * hits `/client/operations/system-health/...` (CLIENT scope, per-user), unlike
 * `get_system_health_availability` which is `/cluster/operations/system-health/...`.
 */
export const ADMIN_TOOLS: ReadonlySet<string> = new Set<string>([
  // clients.ts — the cluster-wide all-tenants directory (/cluster/operations/clients)
  "list_clients",
  "get_client_by_id",
  "get_client_by_name",
  // admin.ts — cluster ops/logs
  "get_system_health_availability",
  "get_cluster_api_error_log",
  "get_cluster_audit_history",
  // generated/cluster.ts — /cluster/{operations,configuration}/...
  "get_cluster_client_auxiliary_databases",
  "get_cluster_external_user_clients",
  "get_cluster_external_user",
  "list_cluster_external_users",
  "get_cluster_error_log",
  "get_cluster_housekeeping_log",
  "get_cluster_system_tasks",
  "list_cluster_plugins",
  "get_cluster_user_clients",
  "get_cluster_user",
  "get_cluster_user_by_name",
  "get_cluster_user_profile",
  "list_cluster_users",
]);

export type ToolScope = "user" | "admin";

export function scopeOf(toolName: string): ToolScope {
  return ADMIN_TOOLS.has(toolName) ? "admin" : "user";
}

/**
 * Detect an admin-classifiable endpoint path — used ONLY by the drift-guard
 * test to assert the static ADMIN_TOOLS set covers every cluster/system-health
 * endpoint. Not used at runtime (runtime keys off ADMIN_TOOLS by name).
 */
export function isAdminEndpoint(path: string): boolean {
  return path.startsWith("/cluster");
}

/** True when the deployment enforces per-user auth (AUTH_REQUIRED !== "false"). */
export function isAuthRequired(): boolean {
  return process.env.AUTH_REQUIRED !== "false";
}

/**
 * Thrown when a user-scoped tool is invoked under AUTH_REQUIRED=true with no
 * user token. This is the fail-closed guarantee (never fall back to proxy for a
 * user tool). The registrar catches it, LOGS it (the signal worth surfacing),
 * and returns a clean auth-required message to the caller.
 */
export class ScopeAuthError extends Error {
  constructor(public readonly toolName: string) {
    super(
      `Tool "${toolName}" is user-scoped and requires an authenticated user, ` +
        `but no user token was present under AUTH_REQUIRED=true (fail-closed; ` +
        `proxy fallback is not permitted for user-scoped tools).`,
    );
    this.name = "ScopeAuthError";
  }
}

let _authService: RPIAuthService | null = null;

/** Wire the proxy-token source once at server boot (createRPIMcpServer). */
export function initAuthScope(authService: RPIAuthService): void {
  _authService = authService;
}

/**
 * The central identity decision. Returns the token the call must run under, or
 * throws ScopeAuthError (fail-closed) / the proxy error (misconfig).
 */
export async function resolveToolAuth(
  toolName: string,
  userToken: string | undefined,
): Promise<string> {
  const proxy = async (): Promise<string> => {
    if (!_authService) {
      throw new Error("auth-scope not initialized (initAuthScope was not called)");
    }
    return _authService.getProxyToken();
  };

  // Dev/loose: proxy for everything (unchanged behavior).
  if (!isAuthRequired()) {
    return userToken ?? (await proxy());
  }

  // Per-user/prod:
  if (userToken) {
    // Run as the user — RPI enforces their real role. Applies to user AND admin
    // tools; a non-admin hitting an admin tool 403s at RPI (handled gracefully).
    return userToken;
  }
  if (scopeOf(toolName) === "admin") {
    // Genuine no-user system/background op → the shared service account.
    return await proxy();
  }
  // User-scoped tool, no user token → fail closed. NEVER proxy.
  throw new ScopeAuthError(toolName);
}

/** Standard MCP tool result carrying a clean, non-leaky error message. */
export interface ToolTextResult {
  content: { type: "text"; text: string }[];
  isError: true;
}
function toolError(text: string): ToolTextResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Classify an error thrown by a tool handler into a clean, role-appropriate
 * message — NEVER a raw status/body (consistent with the http-error no-leak
 * guarantee). Returns null when the error is not an auth/authz condition we
 * soften (caller rethrows so the SDK formats it).
 *
 * Keys off the typed status on RpiApiError (see rpi-api.ts).
 */
export function classifyToolError(
  err: unknown,
  toolName: string,
): ToolTextResult | null {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) {
    return toolError(
      "Your RPI session has expired or is no longer valid. Please sign in again.",
    );
  }
  if (status === 403) {
    return scopeOf(toolName) === "admin"
      ? toolError("This operation is not available for your role.")
      : toolError("You are not authorized to access this resource.");
  }
  return null;
}

/**
 * Handle a ScopeAuthError (fail-closed): LOG it (the signal we DO want to see —
 * a user tool reached execution with no user token) and return a clean message.
 */
export function handleScopeAuthError(err: ScopeAuthError): ToolTextResult {
  console.error(`[auth-scope] FAIL-CLOSED: ${err.message}`);
  return toolError(
    "Authentication required — this operation needs an authenticated user session.",
  );
}
