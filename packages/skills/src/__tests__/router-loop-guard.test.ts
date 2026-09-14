/**
 * #27897 Fix 2 — the sub-agent repeated-tool-call guard. A dispatch that loops
 * the SAME tool with identical args (observed: get_interaction_by_id 20+ times)
 * must be cut off. These lock: identical calls run up to the threshold then
 * short-circuit WITHOUT re-executing; distinct calls are unaffected; arg key
 * order doesn't matter; and tools with no execute pass through.
 */
import { describe, it, expect } from "bun:test";
import type { Tool } from "ai";
import { guardRepeatedToolCalls } from "../router.js";

function countingTool(): { tool: Tool; calls: () => number } {
  let n = 0;
  const tool = {
    description: "t",
    execute: async (args: unknown) => {
      n += 1;
      return { ok: true, args };
    },
  } as unknown as Tool;
  return { tool, calls: () => n };
}

const run = (t: Tool, args: unknown) =>
  (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {});

describe("guardRepeatedToolCalls", () => {
  it("allows identical calls up to the threshold, then short-circuits", async () => {
    const { tool, calls } = countingTool();
    const g = guardRepeatedToolCalls({ get_x: tool }).get_x;
    const a = { id: "1" };
    const r1 = await run(g, a);
    const r2 = await run(g, a);
    const r3 = await run(g, a); // 3rd identical → guard trips
    expect(r1).toEqual({ ok: true, args: a });
    expect(r2).toEqual({ ok: true, args: a });
    expect(typeof r3).toBe("string");
    expect(r3 as string).toMatch(/already called `get_x`/);
    expect(r3 as string).toMatch(/do not call `get_x` with the same arguments again/i);
    expect(calls()).toBe(2); // underlying ran only twice — the 3rd didn't execute
  });

  it("does not short-circuit DISTINCT arguments", async () => {
    const { tool, calls } = countingTool();
    const g = guardRepeatedToolCalls({ get_x: tool }).get_x;
    await run(g, { id: "1" });
    await run(g, { id: "2" });
    await run(g, { id: "3" });
    expect(calls()).toBe(3); // all distinct → all executed
  });

  it("treats different key order as the same call", async () => {
    const { tool, calls } = countingTool();
    const g = guardRepeatedToolCalls({ get_x: tool }).get_x;
    await run(g, { a: 1, b: 2 });
    await run(g, { b: 2, a: 1 });
    const r3 = await run(g, { a: 1, b: 2 });
    expect(typeof r3).toBe("string"); // same logical args → tripped
    expect(calls()).toBe(2);
  });

  it("counts each tool independently", async () => {
    const x = countingTool();
    const y = countingTool();
    const g = guardRepeatedToolCalls({ get_x: x.tool, get_y: y.tool });
    await run(g.get_x, { id: "1" });
    await run(g.get_x, { id: "1" });
    await run(g.get_y, { id: "1" }); // different tool, own counter
    expect(x.calls()).toBe(2);
    expect(y.calls()).toBe(1);
  });

  it("passes through a tool with no execute", () => {
    const noExec = { description: "d" } as unknown as Tool;
    const g = guardRepeatedToolCalls({ t: noExec });
    expect(g.t).toBe(noExec);
  });
});
