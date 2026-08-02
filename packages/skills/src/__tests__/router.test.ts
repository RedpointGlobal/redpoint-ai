import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { Skill } from "../skill.js";
import { isDispatchable, isInlinedExpert } from "../skill.js";
import { SkillRegistry } from "../registry.js";
import { GROUNDING_PREAMBLE } from "../grounding-preamble.js";

// ---------------------------------------------------------------------------
// Mock the "ai" module so generateText never hits a real provider.
// ---------------------------------------------------------------------------

const mockGenerateText = mock(() =>
  Promise.resolve({ text: "result", toolCalls: [], steps: [] }),
);

mock.module("ai", () => {
  const actual = require("ai");
  return {
    ...actual,
    generateText: mockGenerateText,
    stepCountIs: (n: number) => n,
  };
});

// Import after mocks are set up
const { createSkillRouterTool, buildRouterSystemPrompt } = await import(
  "../router.js"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkill(
  overrides: Partial<Skill> & Pick<Skill, "name" | "type">,
): Skill {
  return {
    title: `${overrides.name} Title`,
    description: `${overrides.name} description`,
    instructions: "Do something useful.",
    maxSteps: 10,
    ...overrides,
  };
}

const expertSkill = makeSkill({
  name: "market-research",
  type: "expert",
  title: "Market Research",
  description: "Answers questions about market trends.",
});

const actionSkill = makeSkill({
  name: "send-email",
  type: "action",
  title: "Send Email",
  description: "Sends emails via the email MCP tool.",
  mcpToolFilter: ["email_send"],
});

// Fake model — we never actually call it because generateText is mocked.
const fakeModel = {} as any;

// ---------------------------------------------------------------------------
// Tests — createSkillRouterTool
// ---------------------------------------------------------------------------

describe("createSkillRouterTool", () => {
  let registry: SkillRegistry;
  let getToolsForSkill: ReturnType<typeof mock>;

  beforeEach(() => {
    registry = new SkillRegistry();
    registry.register(expertSkill);
    registry.register(actionSkill);
    getToolsForSkill = mock(() => Promise.resolve({}));
    mockGenerateText.mockClear();
  });

  it("returns a result for a known skill", async () => {
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    const result = await tool.execute!(
      { skillName: "market-research", input: "Tell me about trends" },
      { toolCallId: "t1", messages: [], abortSignal: undefined as any },
    );

    expect(result).toHaveProperty("skillName", "market-research");
    expect(result).toHaveProperty("result", "result");
    expect(result).toHaveProperty("skillType", "expert");
  });

  it("returns an error with available skill names for an unknown skill", async () => {
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    const result = await tool.execute!(
      { skillName: "non-existent", input: "Hello" },
      { toolCallId: "t2", messages: [], abortSignal: undefined as any },
    );

    expect(result).toHaveProperty("error");
    expect((result as any).error).toContain("Unknown skill");
    expect((result as any).error).toContain("market-research");
    expect((result as any).error).toContain("send-email");
  });

  it("does NOT call getToolsForSkill for expert skills", async () => {
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "market-research", input: "Question" },
      { toolCallId: "t3", messages: [], abortSignal: undefined as any },
    );

    expect(getToolsForSkill).not.toHaveBeenCalled();
  });

  // Phase 2 assembly pins — the shared grounding contract must actually reach
  // the dispatched expert's sub-agent, and must NOT be prepended for action
  // skills. This is the durable home for "GROUNDING_PREAMBLE is wired in."
  it("prepends GROUNDING_PREAMBLE to a dispatched expert's system prompt, curated body after", async () => {
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "market-research", input: "Tell me about trends" },
      { toolCallId: "g1", messages: [], abortSignal: undefined as any },
    );
    const system = (mockGenerateText.mock.calls[0]![0] as { system: string })
      .system;
    expect(system).toContain(GROUNDING_PREAMBLE);
    expect(system).toContain(expertSkill.instructions);
    // Contract first, curated body after.
    expect(system.indexOf(GROUNDING_PREAMBLE)).toBeLessThan(
      system.indexOf(expertSkill.instructions),
    );
  });

  it("does NOT prepend the grounding preamble for action skills (own instructions unchanged)", async () => {
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "send-email", input: "Send a message" },
      { toolCallId: "g2", messages: [], abortSignal: undefined as any },
    );
    const system = (mockGenerateText.mock.calls[0]![0] as { system: string })
      .system;
    expect(system).toBe(actionSkill.instructions);
    expect(system).not.toContain(GROUNDING_PREAMBLE);
  });

  it("calls getToolsForSkill with correct filter for action skills", async () => {
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "send-email", input: "Send a message" },
      { toolCallId: "t4", messages: [], abortSignal: undefined as any },
    );

    expect(getToolsForSkill).toHaveBeenCalledTimes(1);
    expect(getToolsForSkill).toHaveBeenCalledWith(["email_send"]);
  });

  it("end-to-end: hybrid-no-filter receives ALL tools, action-with-filter receives NARROWED subset", async () => {
    // Mirror chat.ts/agui.ts resolver semantics: undefined filter → all tools,
    // present filter → scoped subset. Pinning both paths together so a future
    // refactor can't regress dynamic-default OR the scoping path silently.
    const allTools = {
      list_audiences: { description: "list" } as any,
      create_audience: { description: "create" } as any,
      list_offers: { description: "offers" } as any,
    };
    const resolver = mock(async (filter?: string[]) => {
      if (!filter) return allTools;
      return Object.fromEntries(
        Object.entries(allTools).filter(([n]) => filter.includes(n)),
      );
    });

    const dyn = makeSkill({
      name: "dyn",
      type: "hybrid",
      title: "Dyn",
      description: "no filter",
    });
    const scoped = makeSkill({
      name: "scoped",
      type: "action",
      title: "Scoped",
      description: "explicit filter",
      mcpToolFilter: ["list_audiences"],
    });
    registry.register(dyn);
    registry.register(scoped);

    const tool = createSkillRouterTool(registry, fakeModel, resolver);

    await tool.execute!(
      { skillName: "dyn", input: "x" },
      { toolCallId: "ta", messages: [], abortSignal: undefined as any },
    );
    expect(resolver).toHaveBeenLastCalledWith(undefined);
    const allResult = await resolver.mock.results[0].value;
    expect(Object.keys(allResult)).toEqual([
      "list_audiences",
      "create_audience",
      "list_offers",
    ]);

    await tool.execute!(
      { skillName: "scoped", input: "y" },
      { toolCallId: "tb", messages: [], abortSignal: undefined as any },
    );
    expect(resolver).toHaveBeenLastCalledWith(["list_audiences"]);
    const scopedResult = await resolver.mock.results[1].value;
    expect(Object.keys(scopedResult)).toEqual(["list_audiences"]);
  });

  it("calls getToolsForSkill with undefined filter for hybrid skills without mcpToolFilter (dynamic discovery)", async () => {
    // Tier 1 dynamic-discovery default: when a skill omits mcpToolFilter, the
    // resolver gets undefined and is expected to return ALL discovered tools.
    const dynamicHybrid = makeSkill({
      name: "dynamic-hybrid",
      type: "hybrid",
      title: "Dynamic Hybrid",
      description: "Hybrid skill with no filter — gets all tools at runtime.",
      // no mcpToolFilter
    });
    registry.register(dynamicHybrid);

    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "dynamic-hybrid", input: "Do something" },
      { toolCallId: "t-dyn", messages: [], abortSignal: undefined as any },
    );

    expect(getToolsForSkill).toHaveBeenCalledTimes(1);
    expect(getToolsForSkill).toHaveBeenCalledWith(undefined);
  });

  it("reports toolCallCount and stepCount from generateText result", async () => {
    mockGenerateText.mockImplementation(() =>
      Promise.resolve({
        text: "done",
        toolCalls: [{ id: "tc1" }, { id: "tc2" }],
        steps: [{ id: "s1" }],
      }),
    );

    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    const result = await tool.execute!(
      { skillName: "send-email", input: "Do it" },
      { toolCallId: "t5", messages: [], abortSignal: undefined as any },
    );

    expect(result).toHaveProperty("toolCallCount", 2);
    expect(result).toHaveProperty("stepCount", 1);
  });

  it("propagates subAgentToolCalls across ALL steps — v1.4.1 flattens steps.flatMap (top-level toolCalls is last-step-only per AI SDK)", async () => {
    mockGenerateText.mockImplementation(() =>
      Promise.resolve({
        text: "done",
        // Top-level toolCalls is empty — typical final-step shape (agent
        // emitted text only). Without flattening through steps, the v1.4
        // wire would lose the actual sub-agent calls. v1.4.1 reads them
        // from steps.flatMap.
        toolCalls: [],
        steps: [
          {
            toolCalls: [
              {
                toolName: "list_audiences",
                input: { clientId: "abc-123" },
              },
            ],
          },
          {
            toolCalls: [
              {
                toolName: "get_audience_by_id",
                input: { audienceId: "aud-7" },
              },
            ],
          },
          {
            toolCalls: [],
          },
        ],
      }),
    );

    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    const result = await tool.execute!(
      { skillName: "send-email", input: "Fetch one" },
      { toolCallId: "t6", messages: [], abortSignal: undefined as any },
    );

    expect(result).toHaveProperty("subAgentToolCalls");
    expect((result as { subAgentToolCalls: unknown[] }).subAgentToolCalls).toEqual([
      { toolName: "list_audiences", args: { clientId: "abc-123" } },
      { toolName: "get_audience_by_id", args: { audienceId: "aud-7" } },
    ]);
  });

  it("subAgentToolCalls defaults to [] when sub-agent dispatches nothing", async () => {
    mockGenerateText.mockImplementation(() =>
      Promise.resolve({ text: "answer", toolCalls: [], steps: [] }),
    );

    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    const result = await tool.execute!(
      { skillName: "market-research", input: "What's new?" },
      { toolCallId: "t7", messages: [], abortSignal: undefined as any },
    );

    expect((result as { subAgentToolCalls: unknown[] }).subAgentToolCalls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Pattern A — operation-class dynamic tool filter
  // -------------------------------------------------------------------------

  const opsSkill = makeSkill({
    name: "rpi-audiences",
    type: "action",
    title: "RPI Audiences",
    description: "Audience ops.",
    mcpToolFilter: ["list_audiences", "get_audience_by_id", "run_workflow"],
    operations: {
      list: ["list_audiences"],
      get: ["list_audiences", "get_audience_by_id"],
      workflow: ["list_audiences", "run_workflow"],
    },
  });

  it("Pattern A: operation matches → resolver gets the narrow subset (not full mcpToolFilter)", async () => {
    registry.register(opsSkill);
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "rpi-audiences", input: "list 'em", operation: "list" },
      { toolCallId: "op1", messages: [], abortSignal: undefined as any },
    );
    expect(getToolsForSkill).toHaveBeenCalledWith(["list_audiences"]);
  });

  it("Pattern A: another operation routes to its own subset", async () => {
    registry.register(opsSkill);
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "rpi-audiences", input: "fetch", operation: "get" },
      { toolCallId: "op2", messages: [], abortSignal: undefined as any },
    );
    expect(getToolsForSkill).toHaveBeenCalledWith([
      "list_audiences",
      "get_audience_by_id",
    ]);
  });

  it("Pattern A: missing operation falls back to full mcpToolFilter (safe default)", async () => {
    registry.register(opsSkill);
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      { skillName: "rpi-audiences", input: "do something" },
      { toolCallId: "op3", messages: [], abortSignal: undefined as any },
    );
    expect(getToolsForSkill).toHaveBeenCalledWith([
      "list_audiences",
      "get_audience_by_id",
      "run_workflow",
    ]);
  });

  it("Pattern A: unknown operation falls back to full mcpToolFilter (safe — never strands the sub-agent)", async () => {
    registry.register(opsSkill);
    const tool = createSkillRouterTool(registry, fakeModel, getToolsForSkill);
    await tool.execute!(
      {
        skillName: "rpi-audiences",
        input: "??",
        operation: "totally-made-up",
      },
      { toolCallId: "op4", messages: [], abortSignal: undefined as any },
    );
    expect(getToolsForSkill).toHaveBeenCalledWith([
      "list_audiences",
      "get_audience_by_id",
      "run_workflow",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests — buildRouterSystemPrompt
// ---------------------------------------------------------------------------

const hybridSkill = makeSkill({
  name: "ops-tool",
  type: "hybrid",
  title: "Ops Tool",
  description: "Hybrid ops skill.",
  instructions: "You are an ops specialist.",
  mcpToolFilter: ["run_report"],
});

describe("buildRouterSystemPrompt", () => {
  it("includes the base system prompt", () => {
    const prompt = buildRouterSystemPrompt("You are helpful.", [expertSkill]);
    expect(prompt).toContain("You are helpful.");
  });

  it("inlines expert skill instructions as domain knowledge", () => {
    const prompt = buildRouterSystemPrompt("Base", [expertSkill]);
    expect(prompt).toContain("## Domain Knowledge");
    expect(prompt).toContain("Market Research");
    expect(prompt).toContain(expertSkill.instructions);
  });

  it("does not add execute_skill routing for expert-only skills", () => {
    const prompt = buildRouterSystemPrompt("Base", [expertSkill]);
    expect(prompt).not.toContain("execute_skill");
    expect(prompt).not.toContain("## Routing Guidelines");
  });

  it("adds catalog and routing for actionable skills", () => {
    const prompt = buildRouterSystemPrompt("Base", [expertSkill, actionSkill]);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("send-email");
    expect(prompt).toContain("## Routing Guidelines");
    expect(prompt).toContain("execute_skill");
  });

  it("mentions action and hybrid skill types in guidelines", () => {
    const prompt = buildRouterSystemPrompt("Base", [actionSkill, hybridSkill]);
    expect(prompt).toContain("Action skills");
    expect(prompt).toContain("Hybrid skills");
  });

  it("does not list expert skills in the actionable catalog", () => {
    const prompt = buildRouterSystemPrompt("Base", [expertSkill, actionSkill]);
    expect(prompt).not.toContain("market-research (expert)");
  });

  it("lists a dispatch:true expert in the catalog as a tool-less knowledge entry, not inlined", () => {
    const dispatched = makeSkill({
      name: "rpi-domain-expert",
      type: "expert",
      dispatch: true,
      title: "RPI Domain Expert",
      description: "Domain knowledge for building campaigns.",
      instructions: "DISPATCHED_KNOWLEDGE_BODY",
    });
    const prompt = buildRouterSystemPrompt("Base", [dispatched, actionSkill]);
    // Catalogued as a knowledge entry...
    expect(prompt).toContain("**rpi-domain-expert** (knowledge)");
    // ...its body is NOT inlined into Domain Knowledge...
    expect(prompt).not.toContain("DISPATCHED_KNOWLEDGE_BODY");
    // ...and its catalog line carries no Tools:/Operations: surface.
    const line = prompt.split("\n").find((l) => l.includes("**rpi-domain-expert**"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/Tools:|Operations:/);
  });

  it("renders rpi-foundation-expert first in the Domain Knowledge block", () => {
    // Cosmetic ride-along: foundation is "house style" (always-
    // on guidance about clientId, folder lookups, terminology, error patterns).
    // Better for the router LLM to read it before the per-domain experts.
    const foundation = makeSkill({
      name: "rpi-foundation-expert",
      type: "expert",
      title: "RPI MCP Foundation",
      description: "Cross-cutting essentials.",
      instructions: "FOUNDATION_BODY_MARKER",
    });
    const domain = makeSkill({
      name: "rpi-other-expert",
      type: "expert",
      title: "RPI Other",
      description: "Other domain knowledge.",
      instructions: "AUDIENCE_BODY_MARKER",
    });

    // Pass domain expert first to prove the sort actually flips the order.
    const prompt = buildRouterSystemPrompt("Base", [domain, foundation]);
    const fIdx = prompt.indexOf("FOUNDATION_BODY_MARKER");
    const aIdx = prompt.indexOf("AUDIENCE_BODY_MARKER");
    expect(fIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(-1);
    expect(fIdx).toBeLessThan(aIdx);
  });

  it("Pattern A: emits an `Operations:` line in the catalog when the skill defines operations", () => {
    const opsCatalogSkill = makeSkill({
      name: "rpi-audiences",
      type: "action",
      title: "RPI Audiences",
      description: "Audience ops.",
      mcpToolFilter: ["list_audiences", "get_audience_by_id", "run_workflow"],
      operations: {
        list: ["list_audiences"],
        get: ["list_audiences", "get_audience_by_id"],
        workflow: ["list_audiences", "run_workflow"],
      },
    });
    const prompt = buildRouterSystemPrompt("Base", [opsCatalogSkill]);
    expect(prompt).toMatch(/Operations:\s*list\s*\|\s*get\s*\|\s*workflow/);
    expect(prompt).toContain("pass the `operation` argument");
  });

  it("Pattern A: omits the catalog `Operations:` line when the skill has no operations", () => {
    // Match the catalog format specifically: "\n  Operations:" (two-space indented).
    // The prose in Guideline #11 also references "Operations:" but lives outside
    // the catalog block.
    const prompt = buildRouterSystemPrompt("Base", [actionSkill]);
    expect(prompt).not.toMatch(/\n {2}Operations:/);
  });

  it("preserves registry order for non-foundation experts", () => {
    // Foundation-first sort should be stable for everyone else.
    const a = makeSkill({
      name: "rpi-alpha-expert",
      type: "expert",
      title: "Aud",
      instructions: "BODY_A",
    });
    const b = makeSkill({
      name: "rpi-beta-expert",
      type: "expert",
      title: "Camp",
      instructions: "BODY_B",
    });
    const c = makeSkill({
      name: "rpi-gamma-expert",
      type: "expert",
      title: "Data",
      instructions: "BODY_C",
    });
    const prompt = buildRouterSystemPrompt("Base", [a, b, c]);
    const ai = prompt.indexOf("BODY_A");
    const bi = prompt.indexOf("BODY_B");
    const ci = prompt.indexOf("BODY_C");
    expect(ai).toBeLessThan(bi);
    expect(bi).toBeLessThan(ci);
  });
});

// ---------------------------------------------------------------------------
// Source-pin: sub-agent `maxRetries: 2` lock.
// Mirrors apps/server/src/__tests__/orchestrator.test.ts:51-52's
// `maxRetries: 0` pin. The value is load-bearing — it sits inside the
// timeout invariant (tool 220s < client 240s < Bun idle 255s).
//
// Math: maxRetries: 2 = 3 attempts. 3 × ~60s hung worst-realistic ≈ 180s,
// inside the 220s tool budget. DO NOT RAISE to maxRetries: 3 (= 4 attempts,
// AI SDK default): 4 × 60s = 240s, at the client cap; any further hang
// reintroduces the silent socket kill this invariant closes. Retries (config N) ≠
// attempts (N+1) — that distinction is load-bearing.
//
// Bumped 1 → 2 because the live 2026-05-21 13:33 trace on workspace 077e5635
// surfaced "Failed after 2 attempts. Last error: Too Many Requests" as
// visible user-noise — Azure gpt-4o quota throttles often pair, so 3-attempt
// absorption catches the common double-burst case where 1-retry doesn't.
//
// This test fails loudly if anyone changes the literal away from 2.
// ---------------------------------------------------------------------------
import { readFileSync as _readFileSync } from "node:fs";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { dirname as _dirname, join as _join } from "node:path";

const __thisDir = _dirname(_fileURLToPath(import.meta.url));
const ROUTER_SOURCE = _readFileSync(
  _join(__thisDir, "../router.ts"),
  "utf8",
);

describe("router (executeSkill sub-agent) — maxRetries pin", () => {
  it("sets maxRetries: 2 (sub-agent UX layer; absorbs the common double-burst inside the timeout invariant)", () => {
    expect(ROUTER_SOURCE).toMatch(/maxRetries:\s*2/);
  });
});

// ---------------------------------------------------------------------------
// isDispatchable / isInlinedExpert — the single "actionable vs inlined" predicate.
// These gate the router catalog split AND execute_skill registration across
// chat/agui/a2a, so both branches are pinned.
// ---------------------------------------------------------------------------

describe("isDispatchable / isInlinedExpert", () => {
  it("action and hybrid skills are always dispatchable, never inlined", () => {
    for (const type of ["action", "hybrid"] as const) {
      expect(isDispatchable({ type })).toBe(true);
      expect(isInlinedExpert({ type })).toBe(false);
    }
  });

  it("a plain expert (no dispatch) is inlined, not dispatchable", () => {
    expect(isDispatchable({ type: "expert" })).toBe(false);
    expect(isInlinedExpert({ type: "expert" })).toBe(true);
    expect(isDispatchable({ type: "expert", dispatch: false })).toBe(false);
    expect(isInlinedExpert({ type: "expert", dispatch: false })).toBe(true);
  });

  it("a dispatch:true expert is dispatchable, not inlined", () => {
    expect(isDispatchable({ type: "expert", dispatch: true })).toBe(true);
    expect(isInlinedExpert({ type: "expert", dispatch: true })).toBe(false);
  });
});
