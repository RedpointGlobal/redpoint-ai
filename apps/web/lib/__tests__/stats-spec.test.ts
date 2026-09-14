/**
 * #27897 (P2) — the web mirror's defensive guard for stat-tile args. The server
 * already validated, but <StatTiles> must never render malformed args.
 */
import { describe, it, expect } from "bun:test";
import { isStatsSpec } from "../stats-spec.js";

describe("isStatsSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(isStatsSpec({ tiles: [{ value: "385", label: "Runs", sub: "x" }] })).toBe(true);
  });
  it("accepts a tile without sub", () => {
    expect(isStatsSpec({ tiles: [{ value: "1", label: "y" }] })).toBe(true);
  });
  it("rejects empty tiles", () => {
    expect(isStatsSpec({ tiles: [] })).toBe(false);
  });
  it("rejects a tile missing value/label", () => {
    expect(isStatsSpec({ tiles: [{ label: "y" }] })).toBe(false);
    expect(isStatsSpec({ tiles: [{ value: "1" }] })).toBe(false);
  });
  it("rejects non-objects / missing tiles", () => {
    expect(isStatsSpec(null)).toBe(false);
    expect(isStatsSpec({})).toBe(false);
    expect(isStatsSpec({ tiles: "nope" })).toBe(false);
  });
});
