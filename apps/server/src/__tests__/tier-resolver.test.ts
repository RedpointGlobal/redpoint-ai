import { describe, it, expect } from "bun:test";
import type { Skill } from "@redpoint-ai/skills";
import { resolveTier, type TierMcpInput } from "../agents/tier-resolver.js";

function skill(type: Skill["type"], name = `s-${type}`): Skill {
  return {
    name,
    title: name,
    description: "",
    type,
    instructions: "",
    maxSteps: 10,
  };
}

const SUPPORTS: TierMcpInput = { supportsFiltering: true };
const NO_SUPPORT: TierMcpInput = { supportsFiltering: false };

describe("resolveTier", () => {
  it("returns skill-router when any action skill is present", () => {
    expect(resolveTier([skill("action")], [])).toBe("skill-router");
    expect(resolveTier([skill("action")], [NO_SUPPORT])).toBe("skill-router");
  });

  it("returns skill-router when any hybrid skill is present", () => {
    expect(resolveTier([skill("hybrid")], [])).toBe("skill-router");
  });

  it("returns skill-router with mixed expert + hybrid skills", () => {
    expect(resolveTier([skill("expert"), skill("hybrid")], [])).toBe("skill-router");
  });

  it("returns category-discovery when only experts and every MCP supports filtering", () => {
    expect(resolveTier([skill("expert")], [SUPPORTS])).toBe("category-discovery");
    expect(resolveTier([], [SUPPORTS, SUPPORTS])).toBe("category-discovery");
  });

  it("returns flat when only experts and any MCP lacks filtering (mixed-capability strict-AND)", () => {
    expect(resolveTier([skill("expert")], [SUPPORTS, NO_SUPPORT])).toBe("flat");
    expect(resolveTier([], [NO_SUPPORT])).toBe("flat");
  });

  it("returns flat when no skills and no MCP connections", () => {
    expect(resolveTier([], [])).toBe("flat");
  });

  it("returns flat when only experts and no MCP connections", () => {
    expect(resolveTier([skill("expert")], [])).toBe("flat");
  });
});
