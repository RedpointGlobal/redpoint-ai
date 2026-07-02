import { describe, it, expect, beforeEach } from "bun:test";
import { SkillRegistry } from "../registry.js";
import type { Skill } from "../skill.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<Skill> & Pick<Skill, "name" | "type">): Skill {
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
  tags: ["research", "finance"],
});

const actionSkill = makeSkill({
  name: "send-email",
  type: "action",
  title: "Send Email",
  description: "Sends emails via the email MCP tool.",
  mcpToolFilter: ["email_send"],
  tags: ["communication"],
});

const hybridSkill = makeSkill({
  name: "campaign-optimizer",
  type: "hybrid",
  title: "Campaign Optimizer",
  description: "Analyzes and executes campaign optimizations.",
  mcpToolFilter: ["campaigns_update", "reporting_get"],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  // -------------------------------------------------------------------------
  // register / get
  // -------------------------------------------------------------------------

  describe("register and get", () => {
    it("retrieves a registered skill by name", () => {
      registry.register(expertSkill);
      expect(registry.get("market-research")).toEqual(expertSkill);
    });

    it("returns undefined for an unknown skill name", () => {
      expect(registry.get("non-existent")).toBeUndefined();
    });

    it("overwrites a skill when registered with the same name", () => {
      registry.register(expertSkill);
      const updated = { ...expertSkill, description: "Updated description." };
      registry.register(updated);
      expect(registry.get("market-research")?.description).toBe(
        "Updated description.",
      );
    });
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe("list", () => {
    it("returns an empty array when no skills are registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns all registered skills", () => {
      registry.register(expertSkill);
      registry.register(actionSkill);
      registry.register(hybridSkill);

      const names = registry.list().map((s) => s.name);
      expect(names).toContain("market-research");
      expect(names).toContain("send-email");
      expect(names).toContain("campaign-optimizer");
      expect(names).toHaveLength(3);
    });

    it("each returned skill is the same object that was registered", () => {
      registry.register(expertSkill);
      expect(registry.list()[0]).toBe(expertSkill);
    });
  });

});
