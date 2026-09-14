/**
 * #27897 (P2) — LOCAL mirror of the dashboard contract for the web renderer.
 *
 * Same rationale as chart-spec.ts / stats-spec.ts: apps/web doesn't import the
 * @redpoint-ai/shared *package*, so the type is mirrored here. The AUTHORITATIVE
 * contract + strict Zod validation live in packages/shared/src/schemas/dashboard.ts
 * and run on the server (render_view_dashboard's execute re-validates every spec
 * before returning it). Keep in sync by hand (mirror-drift watch item). Reuses the
 * ChartSpec + StatTile mirrors as its building blocks.
 *
 * Type-only: the runtime `isDashboardSpec` guard is gone — the server re-validates
 * with DashboardSpecSchema before returning the spec, so a malformed spec never
 * reaches the renderer by construction (#27957 Phase 2).
 */
import type { ChartSpec } from "./chart-spec";
import type { StatTile } from "./stats-spec";

export interface DashboardSpec {
  title?: string;
  subtitle?: string;
  tiles?: StatTile[];
  panels: ChartSpec[];
  columns?: number;
}
