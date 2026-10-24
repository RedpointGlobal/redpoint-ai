/**
 * Tool categories for server-side `tools/list` filtering.
 * Each tool domain file calls `createToolRegistrar(server, category)` once and
 * uses the returned function in place of `server.registerTool`, which stamps
 * `_meta.category` onto every tool it registers.
 * Filtering is applied in server.ts when clients pass a `category` or `names`
 * param on `tools/list`.
 */
import { auditLine } from "./tool-audit.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveToolAuth,
  classifyToolError,
  handleScopeAuthError,
  ScopeAuthError,
} from "./auth-scope.js";

export const TOOL_CATEGORIES = [
  "audiences",
  "admin",
  "auth",
  "clients",
  "file-system",
  "folders",
  "interactions",
  "selection-rules",
  // Generated-tool categories. Each new domain adds its category here +
  // a CATEGORY_DESCRIPTIONS entry (compile-gated) as its overlay lands.
  "configuration",
  "files",
  "cluster",
  "data-connectors",
  "workflows",
  "operations",
  "data-import",
  "content-preview",
  "jobs",
  "smart-assets",
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/**
 * Return a bound registrar that adds `_meta.category` to every tool it registers.
 * Call `const registerTool = createToolRegistrar(server, "audiences")` once per
 * domain file and use it in place of `server.registerTool`.
 *
 * The return type is annotated as `McpServer["registerTool"]` so callers keep the
 * method's full generic signature — the schema→handler-args inference. (Typing the
 * impl via `Parameters<…>` instead collapses that generic to `never`, which forces
 * every handler param to implicit-`any`.) The impl is intentionally loose-typed and
 * cast back to the generic method type; the stamping is structurally transparent.
 */
export function createToolRegistrar(
  server: McpServer,
  category: ToolCategory,
): McpServer["registerTool"] {
  const register = (name: string, config: unknown, handler: unknown) => {
    const cfg = config as { _meta?: Record<string, unknown> };
    const stamped = {
      ...(config as Record<string, unknown>),
      _meta: { ...(cfg._meta ?? {}), category },
    };

    // Auth-scoping wrapper — the single choke point every tool passes through.
    // (1) Resolve the identity centrally (auth-scope.resolveToolAuth): inject
    //     the resolved token so the handler's `extra.authInfo.token` flows to the
    //     RPI client, or fail-closed (ScopeAuthError) for a user tool with no
    //     user token under AUTH_REQUIRED=true — never a silent proxy escalation.
    // (2) Classify handler errors into clean, role-appropriate messages (401
    //     session / 403 not-authorized), never a raw status/body.
    const origHandler = handler as (
      args: unknown,
      extra: { authInfo?: { token?: string } & Record<string, unknown> } & Record<
        string,
        unknown
      >,
    ) => unknown;
    // (3) One structured audit line per call (./tool-audit.ts) — outcome, duration,
    //     the principal (a token hash, or rpi-native:<account> for a token-less call), argument NAMES only.
    const wrapped = async (args: unknown, extra: Parameters<typeof origHandler>[1]) => {
      const started = performance.now(); // monotonic: the wall clock can step
      const callerToken = extra?.authInfo?.token;
      const audit = (outcome: "ok" | "error" | "denied") =>
        console.error(auditLine({ token: callerToken, tool: name, args, outcome, durationMs: Math.round(performance.now() - started) }));
      let token: string;
      try {
        token = await resolveToolAuth(name, extra?.authInfo?.token);
      } catch (e) {
        if (e instanceof ScopeAuthError) {
          audit("denied");
          return handleScopeAuthError(e);
        }
        audit("error");
        throw e;
      }
      const injectedExtra = {
        ...extra,
        authInfo: { ...(extra?.authInfo ?? {}), token },
      };
      try {
        const result = await origHandler(args, injectedExtra);
        audit((result as { isError?: boolean } | undefined)?.isError ? "error" : "ok");
        return result;
      } catch (e) {
        audit("error");
        const graceful = classifyToolError(e, name);
        if (graceful) return graceful;
        throw e;
      }
    };

    return (server.registerTool as (n: string, c: unknown, h: unknown) => unknown)(
      name,
      stamped,
      wrapped,
    );
  };
  return register as unknown as McpServer["registerTool"];
}
