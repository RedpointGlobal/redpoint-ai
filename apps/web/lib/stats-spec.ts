/**
 * #27897 (P2) — LOCAL mirror of the stat-tile contract for the web renderer.
 *
 * Same rationale as chart-spec.ts: apps/web doesn't import the @redpoint-ai/shared
 * *package* (Next/webpack workspace hiccup), so the type is mirrored here. The
 * AUTHORITATIVE contract + strict Zod validation live in
 * packages/shared/src/schemas/stats.ts and run on the server (render_stats). Keep
 * this in sync by hand (the mirror-drift watch item).
 */

export interface StatTile {
  value: string;
  label: string;
  sub?: string;
}

export interface StatsSpec {
  tiles: StatTile[];
}

/** Defensive guard — the server already validated, but never render malformed args. */
export function isStatsSpec(x: unknown): x is StatsSpec {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    Array.isArray(s.tiles) &&
    s.tiles.length > 0 &&
    s.tiles.every(
      (t) =>
        !!t &&
        typeof t === "object" &&
        typeof (t as StatTile).value === "string" &&
        typeof (t as StatTile).label === "string",
    )
  );
}
