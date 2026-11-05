/**
 * The sub-agent repeated-tool-call guard. A dispatch that loops
 * the SAME tool with identical args (observed: get_interaction_by_id 20+ times)
 * must be cut off. These lock: identical calls run up to the threshold then
 * short-circuit WITHOUT re-executing; distinct calls are unaffected; arg key
 * order doesn't matter; and tools with no execute pass through.
 */
import { describe, it, expect } from "bun:test";
import type { Tool } from "ai";
import { createGuardState, guardRepeatedToolCalls, subAgentStepSettings } from "../router.js";

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

/** The stop message is an MCP CallToolResult: one text part. */
function stopText(r: unknown): string {
  expect(r).toEqual({ content: [{ type: "text", text: expect.any(String) }] });
  return (r as { content: Array<{ text: string }> }).content[0].text;
}

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
    expect(stopText(r3)).toMatch(/already called `get_x`/);
    expect(stopText(r3)).toMatch(/do not call `get_x` with the same arguments again/i);
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
    expect(stopText(r3)).toMatch(/already called `get_x`/); // same logical args → tripped
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

  // The sub-agent's tools are MCP tools: @ai-sdk/mcp gives each a toModelOutput that
  // reads `"content" in result` — a bare-string result throws there and fails the whole
  // dispatch ("result is not an Object"). The stop message must survive that read.
  it("returns a result an MCP tool's toModelOutput can read", async () => {
    const { tool } = countingTool();
    const mcpToModelOutput = ({ output }: { output: unknown }) => {
      const result = output as { content?: unknown };
      if (!("content" in result) || !Array.isArray(result.content)) {
        return { type: "json", value: result };
      }
      return { type: "content", value: result.content };
    };
    const g = guardRepeatedToolCalls({ get_x: tool }).get_x;
    await run(g, { id: "1" });
    await run(g, { id: "1" });
    const r3 = await run(g, { id: "1" });
    expect(mcpToModelOutput({ output: r3 })).toEqual({
      type: "content",
      value: [{ type: "text", text: stopText(r3) }],
    });
  });

  it("passes through a tool with no execute", () => {
    const noExec = { description: "d" } as unknown as Tool;
    const g = guardRepeatedToolCalls({ t: noExec });
    expect(g.t).toBe(noExec);
  });

  it("counts each short-circuit in the shared state, not the calls that ran", async () => {
    const { tool } = countingTool();
    const state = createGuardState();
    const g = guardRepeatedToolCalls({ get_x: tool }, state).get_x;
    await run(g, { id: "1" });
    await run(g, { id: "1" });
    expect(state.trips).toBe(0); // both ran
    await run(g, { id: "1" });
    expect(state.trips).toBe(1);
    await run(g, { id: "2" }); // distinct args run, no trip
    expect(state.trips).toBe(1);
    await run(g, { id: "1" });
    expect(state.trips).toBe(2);
  });
});

// A sub-agent that keeps re-asking after the stop message burned its whole step
// budget re-calling a blocked tool. The step hook stops offering tool calls once
// the guard has tripped in two steps. Steps, not calls: one step can hold the same
// call many times in parallel (gpt-4.1 has sent 10), before any stop message.
describe("subAgentStepSettings", () => {
  const msgs = [{ role: "user" as const, content: "hi" }];

  it("leaves tool calls on while no step has tripped the guard", () => {
    const g = createGuardState();
    expect(subAgentStepSettings(msgs, g)).toEqual({});
    expect(subAgentStepSettings(msgs, g)).toEqual({});
    expect(g.trippedSteps).toBe(0);
  });

  it("keeps tool calls on after ONE tripped step, however many calls it short-circuited", () => {
    const g = createGuardState();
    subAgentStepSettings(msgs, g);
    g.trips += 8; // one step: 10 identical calls in parallel, 2 ran, 8 short-circuited
    expect(subAgentStepSettings(msgs, g)).toEqual({});
    expect(g.trippedSteps).toBe(1);
    expect(subAgentStepSettings(msgs, g)).toEqual({}); // a step that trips nothing doesn't count
    expect(g.trippedSteps).toBe(1);
  });

  it("forbids tool calls once a second step trips the guard, keeping the tools defined", () => {
    const g = createGuardState();
    g.trips += 1; // the 3rd identical call
    expect(subAgentStepSettings(msgs, g)).toEqual({});
    g.trips += 1; // repeated after the stop message
    expect(subAgentStepSettings(msgs, g)).toEqual({ toolChoice: "none" });
    expect(subAgentStepSettings(msgs, g)).toEqual({ toolChoice: "none" });
  });

  // A dispatch that used its whole step budget on tool calls returned EMPTY text:
  // the budget stopped the loop right after a tool step. Its last step (0-based
  // maxSteps - 1) is text-only, so every dispatch ends on an answer.
  it("forbids tool calls on the last step the budget allows", () => {
    expect(subAgentStepSettings(msgs, createGuardState(), { stepNumber: 8, maxSteps: 10 })).toEqual({});
    expect(subAgentStepSettings(msgs, createGuardState(), { stepNumber: 9, maxSteps: 10 })).toEqual({
      toolChoice: "none",
    });
    expect(subAgentStepSettings(msgs, createGuardState(), { stepNumber: 4, maxSteps: 5 })).toEqual({
      toolChoice: "none",
    });
  });

  it("leaves a budget of 1 its tools", () => {
    expect(subAgentStepSettings(msgs, createGuardState(), { stepNumber: 0, maxSteps: 1 })).toEqual({});
  });

  it("still caps the message history", () => {
    // Far over the prune budget: the oldest tool-result content is truncated.
    const big = "x".repeat(2_000_000);
    const history = [
      { role: "user" as const, content: "q" },
      {
        role: "assistant" as const,
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "get_x", input: {} }],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "c1",
            toolName: "get_x",
            output: { type: "text" as const, value: big },
          },
        ],
      },
      { role: "user" as const, content: "and now?" },
    ];
    const out = subAgentStepSettings(history, { trips: 3, tripsSeen: 2, trippedSteps: 1 });
    expect(out.toolChoice).toBe("none");
    expect(out.messages).toBeDefined();
    expect(out.messages).not.toBe(history);
  });
});
