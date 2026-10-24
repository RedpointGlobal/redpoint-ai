/**
 * The number of tools the server lists (tools/list) with the full compiled-in
 * surface: every registered tool, less the write tools the server disables
 * (server.ts). The binary smoke (scripts/smoke-binary.ts) asserts exactly this
 * count, and src/__tests__/tool-surface.test.ts holds it to the registered tools,
 * so a registration regression fails both. A deliberate change to the surface
 * (a new or generated tool, a write tool allowed) updates it here.
 *
 * A running instance may list fewer: the runtime endpoint mask hides the tools
 * its own OpenAPI spec doesn't serve.
 */
export const EXPOSED_TOOL_COUNT = 197;
