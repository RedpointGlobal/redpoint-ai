/**
 * Tool categories for server-side `tools/list` filtering.
 * Each tool domain file calls `createToolRegistrar(server, category)` once and
 * uses the returned function in place of `server.registerTool`, which stamps
 * `_meta.category` onto every tool it registers.
 * Filtering is applied in server.ts when clients pass a `category` or `names`
 * param on `tools/list`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const TOOL_CATEGORIES = [
  "audiences",
  "admin",
  "auth",
  "clients",
  "file-system",
  "folders",
  "interactions",
  "selection-rules",
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
    return (server.registerTool as (n: string, c: unknown, h: unknown) => unknown)(
      name,
      stamped,
      handler,
    );
  };
  return register as unknown as McpServer["registerTool"];
}
