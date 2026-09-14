/**
 * #27957 (Phase 2) — the render_view_dashboard orchestrator tool (single dispatcher).
 *
 * The DETERMINISTIC replacement for the old LLM-composed render_dashboard. The LLM
 * no longer authors a DashboardSpec — it picks a `viewId` and extracts a small
 * `params` set. execute() looks the view up in the registry, calls its `dataSource`
 * (a dumb, per-user structured fetch via the authed mcpTools map), runs its PURE
 * `templateFn` → DashboardSpec, re-validates that spec, and RETURNS it as the tool
 * RESULT. assistant-ui renders <AgentDashboard> from the RESULT (not the args), so
 * composition — the old source of panel-drop variance — leaves the model entirely.
 *
 * A new view is one registry entry: no new tool, rendering code, or routing eval.
 */
import { tool, jsonSchema, type Tool } from "ai";
import { DashboardSpecSchema } from "@redpoint-ai/shared";
import { viewRegistry, viewIds, type ViewContext } from "./dashboards/registry.js";

function buildViewCatalog(): string {
  return viewIds.map((id) => `- ${id}: ${viewRegistry[id].description}`).join("\n");
}

const DESCRIPTION =
  "Render a deterministic, code-assembled dashboard for a 'dashboard', 'report', " +
  "'overview', or 'trend' request. You do NOT compose the layout — pick a `viewId` " +
  "and pass its `params`; the server fetches the data and assembles the view. " +
  "Available views:\n" +
  buildViewCatalog() +
  "\nThe dashboard renders inline in the chat; do not repeat its figures in text.";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    viewId: {
      type: "string",
      enum: viewIds,
      description: "Which canned view to render (see the tool description for each view's params).",
    },
    params: {
      type: "object",
      description:
        "The view's parameters (e.g. { fromDate, toDate, granularity, executionMode }). " +
        "Validated server-side against the selected view's schema.",
    },
  },
  required: ["viewId", "params"],
} as const;

/**
 * @param ctx per-request view context (the authed, per-user mcpTools map). The
 *            factory is called in the route where that map is already built.
 */
export function createRenderViewDashboardTool(ctx: ViewContext): Tool {
  return tool({
    description: DESCRIPTION,
    inputSchema: jsonSchema(inputSchema as unknown as Record<string, unknown>),
    execute: async (input: unknown) => {
      const { viewId, params } = (input ?? {}) as { viewId?: string; params?: unknown };
      const view = viewId ? viewRegistry[viewId] : undefined;
      if (!view) {
        return (
          `Unknown viewId "${viewId ?? ""}". Available views: ${viewIds.join(", ")}. ` +
          `Call render_view_dashboard again with one of these.`
        );
      }

      const parsedParams = view.paramsSchema.safeParse(params);
      if (!parsedParams.success) {
        const issues = parsedParams.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return `Params rejected for view "${viewId}" — ${issues}. Fix these and call render_view_dashboard again.`;
      }

      let data: unknown;
      try {
        data = await view.dataSource(parsedParams.data, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Could not load data for view "${viewId}": ${msg}`;
      }

      const spec = view.templateFn(data, parsedParams.data);
      // Authoritative gate: a malformed spec never reaches the client — the tool-UI
      // renders the RESULT and trusts it. (templateFn is pure + tested, so this is a
      // belt-and-braces check, not a routine path.)
      const validated = DashboardSpecSchema.safeParse(spec);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return `Internal: view "${viewId}" produced an invalid dashboard spec (${issues}).`;
      }
      // Return the assembled spec as the RESULT — the tool-UI renders from it.
      return validated.data;
    },
  });
}
