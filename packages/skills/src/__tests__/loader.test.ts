import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { loadSkillFromFile } from "../loader.js";
import { inferSkillType } from "../skill.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeTempSkill(
  dir: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  lines.push(body);

  const filePath = join(dir, "SKILL.md");
  await writeFile(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadSkillFromFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `skill-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses a minimal expert skill correctly", async () => {
    const filePath = await writeTempSkill(
      tempDir,
      {
        name: "market-analysis",
        title: "Market Analysis",
        description: "Provides in-depth market analysis.",
        maxSteps: 5,
      },
      "You are a market analysis expert. Answer questions with data-backed insights.",
    );

    const skill = await loadSkillFromFile(filePath);

    expect(skill.name).toBe("market-analysis");
    expect(skill.title).toBe("Market Analysis");
    expect(skill.description).toBe("Provides in-depth market analysis.");
    expect(skill.maxSteps).toBe(5);
    expect(skill.instructions).toBe(
      "You are a market analysis expert. Answer questions with data-backed insights.",
    );
    // No mcpToolFilter -> should be expert
    expect(skill.type).toBe("expert");
    expect(skill.mcpToolFilter).toBeUndefined();
    expect(skill.tags).toBeUndefined();
  });

  it("parses optional fields (tags, mcpToolFilter) when present", async () => {
    const filePath = await writeTempSkill(
      tempDir,
      {
        name: "data-fetcher",
        title: "Data Fetcher",
        description: "Fetches data from external APIs.",
        maxSteps: 8,
        mcpToolFilter: ["http_get", "http_post"],
        tags: ["api", "data"],
      },
      "Use the HTTP tools to retrieve data.",
    );

    const skill = await loadSkillFromFile(filePath);

    expect(skill.mcpToolFilter).toEqual(["http_get", "http_post"]);
    expect(skill.tags).toEqual(["api", "data"]);
    // Short instructions + mcpToolFilter -> action
    expect(skill.type).toBe("action");
  });

  it("parses Pattern A `operations:` nested-map frontmatter (each operation maps to a tool-name array)", async () => {
    const raw = `---
name: rpi-audiences
title: RPI Audiences
description: Audience ops with operation-class filtering.
type: action
mcpToolFilter: [list_audiences, get_audience_by_id, run_workflow]
operations:
  list: [list_audiences]
  get: [list_audiences, get_audience_by_id]
  workflow: [list_audiences, run_workflow]
---

Body.`;
    const filePath = join(tempDir, "SKILL.md");
    await writeFile(filePath, raw, "utf-8");

    const skill = await loadSkillFromFile(filePath);

    expect(skill.operations).toEqual({
      list: ["list_audiences"],
      get: ["list_audiences", "get_audience_by_id"],
      workflow: ["list_audiences", "run_workflow"],
    });
    // The full mcpToolFilter remains for the safe-fallback path.
    expect(skill.mcpToolFilter).toEqual([
      "list_audiences",
      "get_audience_by_id",
      "run_workflow",
    ]);
  });

  it("leaves `operations` undefined when the frontmatter omits it (backward-compat)", async () => {
    const filePath = await writeTempSkill(
      tempDir,
      {
        name: "no-ops",
        title: "No Ops",
        description: "Skill without operations block.",
        mcpToolFilter: ["something"],
      },
      "Body.",
    );
    const skill = await loadSkillFromFile(filePath);
    expect(skill.operations).toBeUndefined();
  });

  it("respects an explicit type field in frontmatter, overriding inference", async () => {
    const filePath = await writeTempSkill(
      tempDir,
      {
        name: "forced-hybrid",
        title: "Forced Hybrid",
        description: "A skill with an explicit type override.",
        maxSteps: 10,
        type: "hybrid",
        // No mcpToolFilter, but type is explicitly hybrid
      },
      "Short body.",
    );

    const skill = await loadSkillFromFile(filePath);

    expect(skill.type).toBe("hybrid");
  });

  it("trims leading/trailing whitespace from instructions body", async () => {
    const filePath = await writeTempSkill(
      tempDir,
      {
        name: "trim-test",
        title: "Trim Test",
        description: "Tests body trimming.",
        maxSteps: 3,
      },
      "\n\n  Hello world.  \n\n",
    );

    const skill = await loadSkillFromFile(filePath);
    expect(skill.instructions).toBe("Hello world.");
  });

  it("applies maxSteps default (10) when not specified", async () => {
    // gray-matter doesn't set defaults; Zod schema does. Build raw YAML without maxSteps.
    const filePath = join(tempDir, "SKILL.md");
    await writeFile(
      filePath,
      [
        "---",
        "name: default-steps",
        "title: Default Steps",
        "description: Uses default maxSteps.",
        "---",
        "Instructions here.",
      ].join("\n"),
      "utf-8",
    );

    const skill = await loadSkillFromFile(filePath);
    expect(skill.maxSteps).toBe(10);
  });

  it("throws when required frontmatter fields are missing", async () => {
    const filePath = join(tempDir, "SKILL.md");
    // Missing 'title' and 'description'
    await writeFile(
      filePath,
      ["---", "name: incomplete-skill", "---", "Some instructions."].join("\n"),
      "utf-8",
    );

    expect(loadSkillFromFile(filePath)).rejects.toThrow();
  });

  it("throws when maxSteps is out of range (> 50)", async () => {
    const filePath = await writeTempSkill(
      tempDir,
      {
        name: "too-many-steps",
        title: "Too Many Steps",
        description: "Exceeds maxSteps limit.",
        maxSteps: 99,
      },
      "Instructions.",
    );

    expect(loadSkillFromFile(filePath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// inferSkillType unit tests
// ---------------------------------------------------------------------------

describe("inferSkillType", () => {
  it("returns 'expert' when mcpToolFilter is undefined", () => {
    expect(inferSkillType(undefined, "Any length of instructions here.")).toBe(
      "expert",
    );
  });

  it("returns 'expert' when mcpToolFilter is an empty array", () => {
    expect(inferSkillType([], "Some instructions.")).toBe("expert");
  });

  it("returns 'action' when mcpToolFilter is set and instructions are short (<=200 chars)", () => {
    const shortInstructions = "Use the tool to complete the task."; // well under 200
    expect(inferSkillType(["my_tool"], shortInstructions)).toBe("action");
  });

  it("returns 'hybrid' when mcpToolFilter is set and instructions are long (>200 chars)", () => {
    const longInstructions = "A".repeat(201);
    expect(inferSkillType(["my_tool"], longInstructions)).toBe("hybrid");
  });

  it("returns 'action' when instructions are exactly 200 characters", () => {
    const exactInstructions = "B".repeat(200);
    expect(inferSkillType(["tool_a"], exactInstructions)).toBe("action");
  });

  it("returns 'hybrid' when instructions are 201 characters", () => {
    const oneOver = "C".repeat(201);
    expect(inferSkillType(["tool_b"], oneOver)).toBe("hybrid");
  });

  it("returns 'action' when instructions are only whitespace (trims to empty)", () => {
    // The loader trims before passing; test the raw function with whitespace-only string
    expect(inferSkillType(["tool_x"], "   \n  ")).toBe("action");
  });
});
