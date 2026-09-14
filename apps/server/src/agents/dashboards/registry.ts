/**
 * #27957 (Phase 2) — the view-dashboard registry.
 *
 * The deterministic replacement for LLM-composed dashboards. The LLM's only job is
 * intent + params: pick a `viewId` and extract a small param set. CODE fetches the
 * data (`dataSource`) and assembles the spec (`templateFn`, PURE); the assembled
 * DashboardSpec is returned as the tool RESULT and rendered from the result.
 *
 * A new view = one registry entry — no new tool registration, rendering code, or
 * routing eval. The single dispatcher (render_view_dashboard) dispatches on `id`.
 */
import type { ZodTypeAny } from "zod";
import type { Tool } from "ai";
import type { DashboardSpec } from "@redpoint-ai/shared";
import { interactionRunCountsView } from "./interaction-run-counts.js";

/**
 * Per-request context a view's `dataSource` fetches with. The authed, per-user
 * mcpTools map (built in routes/chat.ts with the caller's RPI token + active
 * tenant already baked in) — so a view fetches AS THE USER, never the proxy.
 */
export interface ViewContext {
  mcpTools: Record<string, Tool>;
}

export interface ViewDashboard<TParams = unknown, TData = unknown> {
  /** The viewId the LLM selects. */
  id: string;
  /** One-line catalog description (what the view shows + its params) for the LLM. */
  description: string;
  /** Small param set the LLM extracts (dateRange, granularity, …). Validated in
   *  the dispatcher via safeParse; ZodTypeAny keeps schemas with defaults (whose
   *  input type differs from the parsed output) assignable. */
  paramsSchema: ZodTypeAny;
  /** DUMB fetch — names one specific tool/endpoint; returns structured data. */
  dataSource(params: TParams, ctx: ViewContext): Promise<TData>;
  /** PURE assembly — (data, params) → DashboardSpec. Deterministic, no I/O, no LLM. */
  templateFn(data: TData, params: TParams): DashboardSpec;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const viewRegistry: Record<string, ViewDashboard<any, any>> = {
  [interactionRunCountsView.id]: interactionRunCountsView,
};

export const viewIds = Object.keys(viewRegistry);
