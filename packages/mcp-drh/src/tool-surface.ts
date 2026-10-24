/**
 * The number of tools the server lists (tools/list) with a configured backend:
 * every registered tool, less the write tools the server disables (server.ts). The
 * binary smoke (scripts/smoke-binary.ts) asserts exactly this count, and
 * src/__tests__/tool-surface.test.ts holds it to the registered tools, so a
 * registration regression fails both. A deliberate change to the surface (a new
 * tool, a write tool allowed) updates it here.
 *
 * With no backend configured (DRH_API_URL / DRH_DEFAULT_CLIENT_ID unset) the
 * server lists none.
 */
export const EXPOSED_TOOL_COUNT = 57;
