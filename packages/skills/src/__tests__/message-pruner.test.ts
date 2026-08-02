/**
 * Tests for `pruneMessageHistory` — specifically protect against the
 * silent-wrong-answer failure mode (worse than an explicit overflow).
 * See the recipient-incident diagnosis this fix addresses.
 */
import { describe, it, expect } from "bun:test";
import type { ModelMessage, UIMessage } from "ai";
import {
  convertToModelMessages,
  jsonSchema,
  tool,
  validateUIMessages,
} from "ai";
import {
  pruneMessageHistory,
  estimateTokens,
  estimateMessageArrayTokens,
  MessageBudgetExceeded,
} from "../message-pruner.js";

// ---------- Helpers ----------

const sys = (content: string): ModelMessage => ({ role: "system", content });
const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});
const tool = (content: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "noop",
      output: { type: "json", value: { data: content } },
    },
  ] as ModelMessage["content"],
});

/** Find the user-visible text in a (possibly post-truncation) tool message. */
function extractToolResultText(m: ModelMessage): string {
  if (m.role !== "tool") return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  for (const p of m.content) {
    if (
      p &&
      typeof p === "object" &&
      (p as { type?: string }).type === "tool-result"
    ) {
      const tr = p as { output?: { type?: string; value?: unknown } };
      const out = tr.output;
      if (!out) continue;
      if (out.type === "text" && typeof out.value === "string") return out.value;
      if (out.type === "json") return JSON.stringify(out.value ?? null);
    }
  }
  return "";
}

// Build a long history: N (user, assistant, tool) triplets + an active user.
// Each tool message carries `bigBlob` chars to push us over budget.
function buildOversizedHistory(
  triplets: number,
  bigBlobChars: number,
): ModelMessage[] {
  const blob = "x".repeat(bigBlobChars);
  const msgs: ModelMessage[] = [sys("You are RedpointAI. Help the user.")];
  for (let i = 0; i < triplets; i++) {
    msgs.push(user(`historical question ${i}`));
    msgs.push(assistant(`historical answer ${i}`));
    msgs.push(tool(`historical tool result ${i}: ${blob}`));
  }
  msgs.push(user("ACTIVE: this is the user's current question"));
  return msgs;
}

/** Tokens of just the user-visible text in a message (no envelope). */
function visibleTextTokens(m: ModelMessage): number {
  const c = m.content;
  if (typeof c === "string") return estimateTokens(c);
  if (!Array.isArray(c)) return 0;
  let s = 0;
  for (const p of c) {
    if (!p || typeof p !== "object") continue;
    const pa = p as {
      type?: string;
      text?: string;
      output?: { type?: string; value?: unknown };
    };
    if (pa.type === "text" || pa.type === "reasoning") {
      s += estimateTokens(typeof pa.text === "string" ? pa.text : "");
    } else if (pa.type === "tool-call") {
      const tc = p as { toolName?: string; input?: unknown };
      s += estimateTokens(
        `${tc.toolName ?? ""}(${JSON.stringify(tc.input ?? {})})`,
      );
    } else if (pa.type === "tool-result" && pa.output) {
      const out = pa.output;
      if (out.type === "text" && typeof out.value === "string") {
        s += estimateTokens(out.value);
      } else if (out.type === "json") {
        s += estimateTokens(JSON.stringify(out.value ?? null));
      } else if (out.type === "content" && Array.isArray(out.value)) {
        for (const inner of out.value) {
          if (
            inner &&
            typeof inner === "object" &&
            "text" in inner &&
            typeof (inner as { text?: unknown }).text === "string"
          ) {
            s += estimateTokens((inner as { text: string }).text);
          }
        }
      }
    }
  }
  return s;
}

function totalVisibleTextTokens(msgs: readonly ModelMessage[]): number {
  let s = 0;
  for (const m of msgs) s += visibleTextTokens(m);
  return s;
}

// ---------- Verification path (mirrors the plan-file test plan) ----------

describe("pruneMessageHistory — silent-wrong-answer protection", () => {
  it("(1) repro: synthetic >128K message array fits budget after prune, AND last user + system are byte-identical preserved", () => {
    const input = buildOversizedHistory(30, 60_000); // ~1.8M chars of tool blobs
    const before = JSON.stringify(input);
    const pruned = pruneMessageHistory(input);

    // Budget honored (default 60K). Estimator counts visible text only;
    // 70K leaves slack for the drop-note + per-message envelope.
    const prunedVisible = totalVisibleTextTokens(pruned);
    expect(prunedVisible).toBeLessThanOrEqual(70_000);

    // Input array NOT mutated.
    expect(JSON.stringify(input)).toBe(before);

    // System (original) preserved byte-identical, in order.
    expect(pruned[0]).toEqual(input[0]);

    // Last user message preserved byte-identical at the tail.
    expect(pruned[pruned.length - 1]).toEqual(input[input.length - 1]);
  });

  it("(2) property: active user message + everything after it are NEVER prunable", () => {
    const input = buildOversizedHistory(30, 60_000);
    const activeStart = input.length - 1; // the last user message
    const activeSlice = input.slice(activeStart);

    const pruned = pruneMessageHistory(input);

    // Every active-turn message appears verbatim in the pruned output (in the
    // same relative order, at the tail).
    const tail = pruned.slice(pruned.length - activeSlice.length);
    expect(tail).toEqual(activeSlice);
  });

  it("(3) truncation semantics: every truncated tool result carries the explicit '[truncated due to budget — N tokens dropped]' marker inside output.value", () => {
    // Force a budget that requires tool-result truncation but no turn drops.
    const input: ModelMessage[] = [
      sys("system"),
      user("q1"),
      tool("x".repeat(40_000)), // huge tool result
      user("ACTIVE"),
    ];
    const pruned = pruneMessageHistory(input, { budgetTokens: 5_000 });

    // Find the (now-truncated) historical tool message and read its rendered output.
    const truncated = pruned.find(
      (m) => m.role === "tool" && extractToolResultText(m).includes("[truncated due to budget"),
    );
    expect(truncated).toBeDefined();
    const text = extractToolResultText(truncated!);
    const marker = text.match(
      /\[truncated due to budget — (\d+) tokens dropped\]/,
    );
    expect(marker).not.toBeNull();
    expect(Number(marker![1])).toBeGreaterThan(0);
  });

  it("(4) no-op regression: short prompt with small history is a byte-identical no-op (same array reference)", () => {
    const input: ModelMessage[] = [
      sys("system"),
      user("hello"),
      assistant("hi"),
      user("ACTIVE"),
    ];
    const pruned = pruneMessageHistory(input);

    // Same reference (no-op short-circuit) — load-bearing for prepareStep
    // returning `{}` instead of `{ messages: ... }` on every call.
    expect(pruned).toBe(input);
  });

  it("(5) multi-step skill loop: 5 tool-call turns + a fresh user msg → active turn semantics preserved, history bounded", () => {
    // Simulate a sub-agent that ran 5 tool calls in prior turns, plus one
    // active user message + its bound tool calls/assistant in-flight.
    const msgs: ModelMessage[] = [sys("system")];
    for (let i = 0; i < 5; i++) {
      msgs.push(user(`prior question ${i}`));
      msgs.push(assistant(`prior answer ${i}`));
      msgs.push(tool("y".repeat(50_000)));
    }
    msgs.push(user("ACTIVE: run the count for rule X"));
    msgs.push(assistant("calling tool…"));
    msgs.push(tool("active-tool-result"));

    const pruned = pruneMessageHistory(msgs);

    // Active turn (last user + bound assistant/tool) preserved verbatim.
    const activeStart = msgs.length - 3;
    const activeSlice = msgs.slice(activeStart);
    const tail = pruned.slice(pruned.length - activeSlice.length);
    expect(tail).toEqual(activeSlice);

    // Visible-text total bounded.
    expect(totalVisibleTextTokens(pruned)).toBeLessThanOrEqual(70_000);
  });

  it("(6) token estimator: char/4 heuristic returns a positive count proportional to input length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
    // Within ±20% of typical English-text accuracy (not asserting precise
    // tokens-per-char ratio since the heuristic is deliberately rough).
  });

  it("(catastrophic) throws MessageBudgetExceeded when system + active turn alone exceed budget — fail loud, never silently wrong", () => {
    const input: ModelMessage[] = [
      sys("x".repeat(40_000)),
      user("ACTIVE x".repeat(20_000)),
    ];
    expect(() => pruneMessageHistory(input, { budgetTokens: 5_000 })).toThrow(
      MessageBudgetExceeded,
    );
  });

  it("structural: a drop-note system message records how many older messages were pruned", () => {
    // Force step-2 (oldest-turn drop, not just tool truncation): many
    // non-tool messages with sizable content that step-1 cannot shrink.
    const msgs: ModelMessage[] = [sys("system")];
    for (let i = 0; i < 50; i++) {
      msgs.push(user("u".repeat(2_000) + ` ${i}`));
      msgs.push(assistant("a".repeat(2_000) + ` ${i}`));
    }
    msgs.push(user("ACTIVE"));
    const input = msgs;
    const pruned = pruneMessageHistory(input, { budgetTokens: 5_000 });

    const note = pruned.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("older message(s) dropped"),
    );
    expect(note).toBeDefined();
    expect((note!.content as string)).toMatch(
      /^\[note: \d+ older message\(s\) dropped from this LLM call due to/,
    );
  });
});

// ---------- Estimator calibration (2026-05-21 review) ----------
//
// The 5/21 false-positive (435K estimated vs ~14K actual) was caused by
// `JSON.stringify(content)` on a parts array — the SDK envelope (`type`,
// `toolCallId`, `output.type` wrapper, `providerOptions`, quote-escaping)
// got counted as if it were tokenized content. This block locks in the
// **both-bounds** invariant a reviewer called out: 0.5× ≤ estimator ≤ 2× of the
// visible-text token count, on a real ModelMessage[] shaped exactly like
// `prepareStep` receives in production. Under-counting reintroduces
// silent overflow (strictly worse than loud false-positive), so the lower
// bound is load-bearing too.
//
// Ground truth is the visible-text token count rather than a live
// provider's `usage.promptTokens` (no provider creds in unit tests). The
// 0.5×–2× envelope is intentionally generous to absorb char/4 drift; a
// 30× regression like 5/21's would fail this immediately.

describe("pruneMessageHistory — estimator both-bounds calibration", () => {
  function calibrateBoth(messages: ModelMessage[], label: string): void {
    const actual = totalVisibleTextTokens(messages);
    const estimated = estimateMessageArrayTokens(messages);
    // Both-bounds invariant: estimator must stay within [0.5×, 2×] of the
    // visible-text token total. Lower bound prevents silent overflow;
    // upper bound prevents the 5/21 envelope-bloat regression.
    expect(estimated, `[${label}] estimator vs visible`).toBeGreaterThanOrEqual(
      Math.floor(actual * 0.5),
    );
    expect(estimated, `[${label}] estimator vs visible`).toBeLessThanOrEqual(
      Math.ceil(actual * 2),
    );
  }

  it("regression (5/21 shape): tool-result-heavy thread does NOT 30× overcount the JSON envelope", () => {
    // Mirror the 5/21 trace: a few tool-result messages with JSON output
    // payloads (the exact shape the recipient and a live reproduction hit).
    const msgs: ModelMessage[] = [
      sys("System prompt with router catalog."),
      user("List my clients"),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "execute_skill",
            input: { skillName: "rpi-clients", input: "List my clients" },
          },
        ] as ModelMessage["content"],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "execute_skill",
            output: {
              type: "json",
              value: {
                skillName: "rpi-clients",
                skillType: "action",
                result:
                  "Here is the list of clients (tenants) you have on the RPI cluster:\n\n1. **Acme-Retail-Demo**  \n   - ID: a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890  \n   - Description: Acme-Retail-Demo",
                toolCallCount: 0,
                stepCount: 2,
              },
            },
          },
        ] as ModelMessage["content"],
      },
      { role: "assistant", content: "I've listed your clients." },
      user("List audiences for client e0633f… with names starting with 'JB'."),
    ];
    calibrateBoth(msgs, "5/21 shape");
  });

  it("string-content shape: plain user/assistant text estimates within bounds", () => {
    const msgs: ModelMessage[] = [
      sys("System prompt."),
      user("Hello, how are you?"),
      assistant("I'm doing well, thanks for asking."),
      user("Tell me a long story about the desert."),
    ];
    calibrateBoth(msgs, "string-content");
  });

  it("multi-part tool-result with content-array output stays within bounds", () => {
    const msgs: ModelMessage[] = [
      sys("System."),
      user("Run the tool."),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "t",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Part A: actual text content." },
                { type: "text", text: "Part B: more actual text content here." },
              ],
            },
          },
        ] as ModelMessage["content"],
      },
      user("Active."),
    ];
    calibrateBoth(msgs, "content-array output");
  });

  it("envelope-bloat regression: providerOptions on parts must NOT inflate the estimate", () => {
    // ProviderOptions blobs (caching hints etc.) can be larger than the
    // visible content. The 5/21 bug counted them; the fix must not.
    const heavyProviderOptions = {
      anthropic: { cacheControl: { type: "ephemeral" } },
      openai: { someLongOption: "x".repeat(5_000) },
    };
    const msgs: ModelMessage[] = [
      sys("Short."),
      user("Short."),
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Brief assistant text.",
            providerOptions: heavyProviderOptions,
          },
        ] as ModelMessage["content"],
      },
      user("Active."),
    ];
    const actualVisible = totalVisibleTextTokens(msgs);
    const estimated = estimateMessageArrayTokens(msgs);
    // The estimator must NOT count the 5K-char providerOptions blob —
    // it shouldn't be anywhere near 2× the actual visible content.
    expect(estimated).toBeLessThanOrEqual(Math.ceil(actualVisible * 2) + 50); // small constant for envelope+role
  });
});

// ---------- Step 2A: production-pipeline ground-truth calibration ----------
//
// A 2026-05-21 13:14 live trace surfaced
// `Message budget exceeded: 394634 tokens required, 60000 budget` on a
// fresh thread that the LLM saw as ~14K tokens (post-error step-finish
// in:14180 cached:14080). The synthetic regression tests in the block
// above already catch the original 30× JSON-envelope shape, yet the
// production path still 28× overcounts. The gap that let that through
// is structural: the synthetic tests author the ModelMessage[] directly;
// production walks `validateUIMessages` → `convertToModelMessages` first,
// and the converter's output shape may differ in ways the synthetic
// payloads don't exercise.
//
// This block reproduces the production pipeline end-to-end on a thread
// shaped like the live 5/21 trace and asserts the both-bounds invariant
// (0.5× ≤ estimator ≤ 2× of visible-text tokens) on the *actual*
// ModelMessage[] that `prepareStep` would receive. If this fails, the
// failure IS the bug shape we need; the diff between expected and
// actual locates the part type / field the estimator mis-counts.

describe("pruneMessageHistory — production-pipeline ground-truth (Step 2A)", () => {
  /**
   * Stub tool matching the production `execute_skill` surface so
   * `convertToModelMessages` resolves the `tool-execute_skill` parts
   * to standard ModelMessage tool-call / tool-result parts.
   */
  const executeSkillTool = tool({
    description: "Dispatch to a skill sub-agent.",
    inputSchema: jsonSchema<{ skillName: string; input: string }>({
      type: "object",
      properties: {
        skillName: { type: "string" },
        input: { type: "string" },
      },
      required: ["skillName", "input"],
    }),
    outputSchema: jsonSchema<{
      skillName: string;
      skillType: string;
      result: string;
      toolCallCount: number;
      stepCount: number;
    }>({
      type: "object",
      properties: {
        skillName: { type: "string" },
        skillType: { type: "string" },
        result: { type: "string" },
        toolCallCount: { type: "number" },
        stepCount: { type: "number" },
      },
      required: ["skillName", "skillType", "result", "toolCallCount", "stepCount"],
    }),
  });

  /**
   * Build a UIMessage[] mirroring the 5/21 13:14 trace: user "List my
   * clients" → assistant invokes execute_skill rpi-clients → assistant
   * relays the result text → fresh user prompt. The 'output-available'
   * state on the tool part is what production assistant-ui sends.
   */
  function buildLiveShapeUIMessages(): UIMessage[] {
    const skillResult =
      "Here is the list of clients (tenants) on your RPI cluster:\n\n" +
      "1. **Acme-Retail-Demo**\n" +
      "   - ID: `a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890`\n" +
      "   - Description: Acme-Retail-Demo\n\n" +
      "You can use the ID for any specific operations or further inquiries related to this client.";

    return [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "List my clients" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-execute_skill",
            toolCallId: "call-1",
            state: "output-available",
            input: { skillName: "rpi-clients", input: "List my clients" },
            output: {
              skillName: "rpi-clients",
              skillType: "action",
              result: skillResult,
              toolCallCount: 0,
              stepCount: 2,
            },
          } as unknown as UIMessage["parts"][number],
          {
            type: "text",
            text: "I've listed your clients.",
          },
        ],
      },
      {
        id: "u2",
        role: "user",
        parts: [
          {
            type: "text",
            text:
              "List audiences for client a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890 " +
              "(Acme-Retail-Demo) with names starting with 'JB' and counts greater than zero.",
          },
        ],
      },
    ];
  }

  it("(2A.1) estimator stays within [0.5×, 2×] of visible-text on the live 5/21 ModelMessage[] shape (post validate + convert)", async () => {
    const ui = buildLiveShapeUIMessages();
    // Production path: validateUIMessages → convertToModelMessages
    // (mirrors createAgentUIStream's pre-prepareStep transform).
    const validated = await validateUIMessages({
      messages: ui,
      tools: { execute_skill: executeSkillTool },
    });
    const modelMessages = await convertToModelMessages(validated, {
      tools: { execute_skill: executeSkillTool },
    });

    // Sanity: the converter produced the expected role sequence
    // (user, assistant with tool-call, tool with tool-result, assistant
    // text, user). If the converter shape ever changes, this assertion
    // surfaces it before the estimator math gets blamed.
    const roles = modelMessages.map((m) => m.role);
    expect(roles).toContain("tool"); // tool-result message present
    expect(roles[0]).toBe("user");
    expect(roles[roles.length - 1]).toBe("user"); // active turn

    // Ground truth: same visible-text helper the synthetic block uses.
    const actualVisible = totalVisibleTextTokens(modelMessages);
    const estimated = estimateMessageArrayTokens(modelMessages);

    // Both-bounds: lower (under-count → silent overflow) and upper
    // (envelope-bloat → phantom MessageBudgetExceeded). The 5/21 live
    // bug was a 28× upper-bound violation.
    expect(
      estimated,
      `estimator=${estimated} vs visible=${actualVisible} ` +
        `(roles=${roles.join("→")}, msgs=${modelMessages.length})`,
    ).toBeGreaterThanOrEqual(Math.floor(actualVisible * 0.5));
    expect(
      estimated,
      `estimator=${estimated} vs visible=${actualVisible} ` +
        `(roles=${roles.join("→")}, msgs=${modelMessages.length})`,
    ).toBeLessThanOrEqual(Math.ceil(actualVisible * 2));
  });

  it("(2A.2) estimator does NOT throw MessageBudgetExceeded on the live shape at the default 60K budget", async () => {
    const ui = buildLiveShapeUIMessages();
    const validated = await validateUIMessages({
      messages: ui,
      tools: { execute_skill: executeSkillTool },
    });
    const modelMessages = await convertToModelMessages(validated, {
      tools: { execute_skill: executeSkillTool },
    });
    // Default budget = 60K. The live shape has ~250 visible-text tokens;
    // a 30× overcount would put it at ~7500, still under 60K — so we
    // can't rely on the catastrophic throw to detect the bug here. The
    // both-bounds assertion in 2A.1 does the real work; this is just a
    // belt-and-suspenders guard against a different regression mode
    // where the estimator returns Infinity or a NaN-leaking arithmetic.
    expect(() => pruneMessageHistory(modelMessages)).not.toThrow();
  });
});

// ---------- Step 3: active-turn dynamic-cap fix ----------
//
// Live 2026-05-21 14:41 capture proved the active-turn invariant was
// too rigid: a sub-agent paginated tool loop (18 tool-result parts at
// ~22K tokens each) hit `MessageBudgetExceeded` because nothing in the
// active turn was prunable. Step 3 introduces a dynamic per-part cap
// derived from the budget so K=0 (every active-turn tool-result is
// truncated) fits demonstrably by math, not by hoping the tail is
// small.
//
// Tests below use the captured-payload shape as the regression
// fixture plus three edge cases per Flag F.

/** Build a tool message with N tool-result parts, each carrying ~charsPerPart of payload. */
function toolMessageWithNResults(n: number, charsPerPart: number): ModelMessage {
  const parts: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "json"; value: { data: string } } }> = [];
  for (let i = 0; i < n; i++) {
    parts.push({
      type: "tool-result",
      toolCallId: `call-${i}`,
      toolName: "list_audiences",
      output: { type: "json", value: { data: "x".repeat(charsPerPart) } },
    });
  }
  return { role: "tool", content: parts as ModelMessage["content"] };
}

/** Build an assistant message with N tool-call parts (small). */
function assistantMessageWithNCalls(n: number): ModelMessage {
  const parts: Array<{ type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
  for (let i = 0; i < n; i++) {
    parts.push({
      type: "tool-call",
      toolCallId: `call-${i}`,
      toolName: "list_audiences",
      input: { page: i },
    });
  }
  return { role: "assistant", content: parts as ModelMessage["content"] };
}

/** Find tool-result content text (post-prune) in a tool message. */
function getToolResultTexts(m: ModelMessage): string[] {
  if (m.role !== "tool" || !Array.isArray(m.content)) return [];
  const texts: string[] = [];
  for (const p of m.content) {
    if (!p || typeof p !== "object") continue;
    const tr = p as { type?: string; output?: { type?: string; value?: unknown } };
    if (tr.type !== "tool-result" || !tr.output) continue;
    if (tr.output.type === "text" && typeof tr.output.value === "string") {
      texts.push(tr.output.value);
    } else if (tr.output.type === "json") {
      texts.push(JSON.stringify(tr.output.value ?? null));
    }
  }
  return texts;
}

describe("pruneMessageHistory — Step 3 active-turn dynamic cap", () => {
  it("(3.1) captured-payload regression: 18 large active-turn tool-results truncate to dynamic cap; total fits; NO throw", () => {
    // Mirror the captured payload's shape: 5 messages, 18 active-turn
    // tool-result parts at ~160K chars each (40K tokens). Pre-fix this
    // threw 394K tokens > 60K budget. Post-fix: dynamic cap brings each
    // to a few-thousand-token slice, all fit.
    const msgs: ModelMessage[] = [
      user("List audiences with 'JB' and counts > 0"),
      assistantMessageWithNCalls(9),
      toolMessageWithNResults(9, 160_000),
      assistantMessageWithNCalls(9),
      toolMessageWithNResults(9, 140_000),
    ];

    // Default 60K budget. Should NOT throw.
    let pruned: ModelMessage[] | null = null;
    expect(() => {
      pruned = pruneMessageHistory(msgs);
    }).not.toThrow();
    expect(pruned).not.toBeNull();

    // Total fits.
    expect(estimateMessageArrayTokens(pruned!)).toBeLessThanOrEqual(60_000);

    // Active user message preserved verbatim at the head/tail position
    // (no system in this fixture, so msg[0] is the active user).
    expect(pruned![0]).toEqual(msgs[0]);

    // Every active-turn tool-result text carries the truncation marker.
    const allToolResultTexts = pruned!
      .filter((m) => m.role === "tool")
      .flatMap(getToolResultTexts);
    expect(allToolResultTexts.length).toBe(18);
    for (const text of allToolResultTexts) {
      expect(text).toMatch(/\[truncated due to budget — \d+ tokens dropped\]/);
    }
  });

  it("(3.2) Flag F: zero active-turn tool-results — early-return guard (no divide-by-zero, no truncation)", () => {
    // Active turn has user + assistant-text, no tool-calls/results.
    // Even if pre-active content overflows, the active-turn dynamic-
    // cap branch should be skipped entirely without erroring.
    const msgs: ModelMessage[] = [
      sys("system " + "s".repeat(40_000)), // ~10K tokens
      user("u1 " + "u".repeat(100_000)),    // pre-active bloat
      assistant("a1 " + "a".repeat(100_000)),
      user("ACTIVE prompt"),                // active turn, no tool calls
    ];
    let pruned: ModelMessage[] | null = null;
    expect(() => {
      pruned = pruneMessageHistory(msgs, { budgetTokens: 60_000 });
    }).not.toThrow();
    expect(pruned).not.toBeNull();
    // Active user preserved at tail.
    expect(pruned![pruned!.length - 1]).toEqual(msgs[3]);
  });

  it("(3.3) Flag F: single giant active-turn tool-result — cap = full remaining budget; truncation still applies", () => {
    // One tool-result part of ~400K chars (~100K tokens) in the active
    // turn, well over 60K budget so the pruner engages. perPartCap =
    // (budget − fixedReserved − safety) / 1 ≈ remaining-budget; the
    // part gets truncated to that cap.
    const msgs: ModelMessage[] = [
      user("ACTIVE"),
      assistantMessageWithNCalls(1),
      toolMessageWithNResults(1, 400_000),
    ];
    let pruned: ModelMessage[] | null = null;
    expect(() => {
      pruned = pruneMessageHistory(msgs);
    }).not.toThrow();
    expect(pruned).not.toBeNull();
    expect(estimateMessageArrayTokens(pruned!)).toBeLessThanOrEqual(60_000);

    const toolMsgs = pruned!.filter((m) => m.role === "tool");
    const texts = toolMsgs.flatMap(getToolResultTexts);
    expect(texts.length).toBe(1);
    expect(texts[0]).toMatch(/\[truncated due to budget — \d+ tokens dropped\]/);
  });

  it("(3.4) Flag F: small case that already fits — no-op short-circuit (same array reference)", () => {
    // Total under budget; pruner returns the input array unchanged.
    const msgs: ModelMessage[] = [
      sys("system"),
      user("ACTIVE"),
      assistantMessageWithNCalls(1),
      toolMessageWithNResults(1, 500), // tiny — well under any cap
    ];
    const pruned = pruneMessageHistory(msgs);
    expect(pruned).toBe(msgs); // same reference — no-op
  });
});
