/**
 * #27897 (P2) — the stat-tile contract. Locks the shape render_stats and
 * <StatTiles> depend on: tiles validate (with/without sub), and the strict rules
 * (≥1 tile, ≤12, required value+label, no extra props) reject.
 */
import { describe, it, expect } from "bun:test";
import { StatsSpecSchema } from "../schemas/stats.js";

describe("StatsSpecSchema — valid", () => {
  it("a single tile with a sub", () => {
    expect(
      StatsSpecSchema.safeParse({
        tiles: [{ value: "385", label: "Runs this month", sub: "332 test · 53 prod" }],
      }).success,
    ).toBe(true);
  });
  it("a tile without a sub (sub is optional)", () => {
    const p = StatsSpecSchema.safeParse({ tiles: [{ value: "12", label: "Audiences" }] });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.tiles[0].sub).toBeUndefined();
  });
  it("multiple tiles", () => {
    expect(
      StatsSpecSchema.safeParse({
        tiles: [
          { value: "385", label: "Runs" },
          { value: "$1.2M", label: "Revenue" },
          { value: "98.6%", label: "Deliverability" },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("StatsSpecSchema — reject", () => {
  it("empty tiles", () => {
    expect(StatsSpecSchema.safeParse({ tiles: [] }).success).toBe(false);
  });
  it("more than 12 tiles", () => {
    const tiles = Array.from({ length: 13 }, (_, i) => ({ value: `${i}`, label: `m${i}` }));
    expect(StatsSpecSchema.safeParse({ tiles }).success).toBe(false);
  });
  it("missing value", () => {
    expect(StatsSpecSchema.safeParse({ tiles: [{ label: "Runs" }] }).success).toBe(false);
  });
  it("missing label", () => {
    expect(StatsSpecSchema.safeParse({ tiles: [{ value: "385" }] }).success).toBe(false);
  });
  it("empty value string", () => {
    expect(StatsSpecSchema.safeParse({ tiles: [{ value: "", label: "Runs" }] }).success).toBe(false);
  });
  it("unknown/extra field (strict)", () => {
    expect(
      StatsSpecSchema.safeParse({ tiles: [{ value: "1", label: "x", color: "red" }] }).success,
    ).toBe(false);
  });
});
