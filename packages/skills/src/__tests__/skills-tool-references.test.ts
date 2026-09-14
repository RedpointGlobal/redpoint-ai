/**
 * Regression tests enforcing the skill body authoring rule documented in
 * `CONTRIBUTING.md` ("Skill body authoring rule: tool names by skill
 * type"):
 *
 * 1. Every `mcpToolFilter` entry must reference a tool actually registered in
 *    `packages/mcp-rpi/src/tools/*.ts`. Catches stale filter references.
 * 2. Expert skill bodies must not name any registered MCP tool. Expert prose
 *    is always inlined into the router prompt; tool names there go stale and
 *    pollute every conversation.
 * 3. Action/hybrid skill bodies may name only tools listed in the same
 *    skill's `mcpToolFilter`. Tools the skill doesn't own are forbidden.
 *
 * The cross-reference is done by parsing source files (regex match on
 * `registerTool("name", ...)`) so this test has no runtime dependency on
 * mcp-rpi.
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadSkillsFromDirectory } from "../loader.js";

const __testsDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__testsDir, "../../../..");
const SKILLS_DIR = join(REPO_ROOT, "skills");
const MCP_RPI_TOOLS_DIR = join(REPO_ROOT, "packages/mcp-rpi/src/tools");
// DR Hub tools live in their own MCP server package; drh-* skills reference
// them, so the cross-check must span both servers, not just mcp-rpi.
const MCP_DRH_TOOLS_DIR = join(REPO_ROOT, "packages/mcp-drh/src/tools");

/**
 * Skills with known-stale filters that we don't fail the build on. Each entry
 * must include a tracking note. When fixed, remove the entry; if the test
 * still passes, great. If a NEW skill goes stale, it's not in this list and
 * the test will fail loudly — exactly what we want.
 *
 * Empty today — `rpi-marketing` was deleted (its mcpToolFilter
 * referenced aspirational tools that don't exist in mcp-rpi).
 */
const KNOWN_STALE: ReadonlyArray<{ name: string; reason: string }> = [];

function scanToolDir(dir: string, names: Set<string>): void {
  if (!existsSync(dir)) return;
  // Recurse: hand tools live in src/tools/*.ts, generated tools (#27634) in
  // src/tools/generated/*.ts — both register tools the mcpToolFilter can reference.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      scanToolDir(join(dir, entry.name), names);
      continue;
    }
    const file = entry.name;
    if (!file.endsWith(".ts")) continue;
    if (file === "response-shapes.ts") continue;
    const src = readFileSync(join(dir, file), "utf-8");
    for (const m of src.matchAll(/registerTool\(\s*["']([a-z_]+)["']/g)) {
      names.add(m[1]);
    }
  }
}

function collectRegisteredToolNames(): Set<string> {
  if (!existsSync(MCP_RPI_TOOLS_DIR)) {
    throw new Error(`mcp-rpi tools dir not found at ${MCP_RPI_TOOLS_DIR}`);
  }
  const names = new Set<string>();
  scanToolDir(MCP_RPI_TOOLS_DIR, names);
  scanToolDir(MCP_DRH_TOOLS_DIR, names); // DR Hub stub tools (drh-* skills)
  return names;
}

/**
 * Extract every backtick-wrapped snake_case identifier from a skill body
 * that matches a real registered tool name. Picks up both `single_tool` and
 * `multiple` `tool_names` mentions; ignores non-tool-shaped backticks.
 */
function findToolNamesInBody(
  body: string,
  registered: Set<string>,
): Set<string> {
  const found = new Set<string>();
  for (const m of body.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
    if (registered.has(m[1])) found.add(m[1]);
  }
  return found;
}

describe("shipped skills mcpToolFilter cross-reference", () => {
  it("the registered tool inventory is non-empty (sanity)", () => {
    const tools = collectRegisteredToolNames();
    expect(tools.size).toBeGreaterThan(0);
  });

  it("every mcpToolFilter entry on non-stale skills references a real tool", async () => {
    const tools = collectRegisteredToolNames();
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const staleNames = new Set(KNOWN_STALE.map((s) => s.name));

    const errors: string[] = [];
    for (const skill of skills) {
      if (staleNames.has(skill.name)) continue;
      for (const toolName of skill.mcpToolFilter ?? []) {
        if (!tools.has(toolName)) {
          errors.push(
            `Skill "${skill.name}" references tool "${toolName}" — not registered in mcp-rpi`,
          );
        }
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `Stale mcpToolFilter entries:\n  ${errors.join("\n  ")}`,
      );
    }
  });

  it("expert skill bodies do not name any MCP tool", async () => {
    const tools = collectRegisteredToolNames();
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);

    const errors: string[] = [];
    for (const skill of skills) {
      if (skill.type !== "expert") continue;
      const found = findToolNamesInBody(skill.instructions, tools);
      if (found.size > 0) {
        errors.push(
          `Expert skill "${skill.name}" names tools in body: ${[...found].sort().join(", ")}`,
        );
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `Expert bodies must not reference MCP tool names (CONTRIBUTING.md):\n  ${errors.join("\n  ")}`,
      );
    }
  });

  it("action/hybrid skill bodies only name tools listed in their own mcpToolFilter", async () => {
    const tools = collectRegisteredToolNames();
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);

    const errors: string[] = [];
    for (const skill of skills) {
      if (skill.type !== "action" && skill.type !== "hybrid") continue;
      const filter = new Set(skill.mcpToolFilter ?? []);
      const found = findToolNamesInBody(skill.instructions, tools);
      const stray = [...found].filter((name) => !filter.has(name));
      if (stray.length > 0) {
        errors.push(
          `Skill "${skill.name}" (${skill.type}) names tools in body that aren't in its mcpToolFilter: ${stray.sort().join(", ")}`,
        );
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `Action/hybrid bodies may only name their own filtered tools (CONTRIBUTING.md):\n  ${errors.join("\n  ")}`,
      );
    }
  });

  it("known-stale skills are still stale (deletes the allow-list when they're fixed)", async () => {
    const tools = collectRegisteredToolNames();
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);

    for (const { name } of KNOWN_STALE) {
      const skill = skills.find((s) => s.name === name);
      if (!skill) continue;
      const stale = (skill.mcpToolFilter ?? []).filter(
        (t) => !tools.has(t),
      );
      // If a "known-stale" skill no longer has any stale entries, the
      // allow-list entry is obsolete — fail so we delete it.
      expect(stale.length).toBeGreaterThan(0);
    }
  });
});
