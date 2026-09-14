/**
 * #27897 (P2) — render_stats tool. inputSchema derived from the shared Zod
 * StatsSpecSchema; execute strictly re-validates. Valid → confirmation naming the
 * labels; invalid → an actionable rejection the agent can retry against.
 */
import { describe, it, expect } from "bun:test";
import { createRenderStatsTool } from "../agents/render-stats.js";

const call = (spec: unknown) =>
  (createRenderStatsTool() as unknown as {
    execute: (a: unknown, o: unknown) => Promise<string>;
  }).execute(spec, {});

describe("render_stats tool", () => {
  it("has a jsonSchema inputSchema (LLM-facing contract)", () => {
    const t = createRenderStatsTool() as unknown as { inputSchema?: unknown };
    expect(t.inputSchema).toBeDefined();
  });

  it("valid spec → confirmation naming the tile count + labels", async () => {
    const msg = await call({
      tiles: [
        { value: "385", label: "Runs this month", sub: "332 test · 53 prod" },
        { value: "12", label: "Audiences" },
      ],
    });
    expect(msg).toMatch(/rendered 2 stat-tile/i);
    expect(msg).toContain("Runs this month");
    expect(msg).toContain("Audiences");
  });

  it("invalid (empty tiles) → rejection, not a render", async () => {
    const msg = await call({ tiles: [] });
    expect(msg).toMatch(/rejected/i);
    expect(msg).toMatch(/render_stats again/i);
  });

  it("invalid (tile missing value) → rejection", async () => {
    const msg = await call({ tiles: [{ label: "Runs" }] });
    expect(msg).toMatch(/rejected/i);
  });
});
