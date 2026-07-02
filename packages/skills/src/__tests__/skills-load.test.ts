/**
 * Regression test: every SKILL.md shipped under the repo-root `skills/`
 * directory must parse successfully against the loader's Zod schema.
 *
 * The other loader tests use synthetic fixtures and exercise the parser; this
 * one runs the parser against the real files. A frontmatter regression in any
 * shipped skill — bad YAML, missing required field, out-of-range maxSteps —
 * fails this test, surfacing the breakage at PR time rather than at server
 * boot.
 */
import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadSkillsFromDirectory } from "../loader.js";

const __testsDir = dirname(fileURLToPath(import.meta.url));
// packages/skills/src/__tests__ → repo root is 4 levels up
const SKILLS_DIR = join(__testsDir, "../../../../skills");

describe("repo skills/ directory", () => {
  it("exists at the expected repo-root path", () => {
    expect(existsSync(SKILLS_DIR)).toBe(true);
  });

  it("loads every SKILL.md without schema errors", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    expect(skills.length).toBeGreaterThan(0);
  });

  it("contains the expected RPI skill set", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const names = new Set(skills.map((s) => s.name));
    const required = [
      "rpi-foundation-expert",
      "rpi-audiences",
      "rpi-interactions",
      "rpi-selection-rules",
      "rpi-folders",
    ];
    for (const name of required) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("each shipped skill has a unique name", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const names = skills.map((s) => s.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it("expert-foundation skill is type=expert with no mcpToolFilter (always inlined)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const foundation = skills.find((s) => s.name === "rpi-foundation-expert");
    expect(foundation).toBeDefined();
    expect(foundation!.type).toBe("expert");
    expect(foundation!.mcpToolFilter ?? []).toEqual([]);
    // Foundation is inlined, NOT dispatched.
    expect(foundation!.dispatch ?? false).toBe(false);
  });

  it("rpi-domain-expert is a dispatched (dispatch:true), tool-less knowledge expert", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const expert = skills.find((s) => s.name === "rpi-domain-expert");
    expect(expert).toBeDefined();
    expect(expert!.type).toBe("expert");
    expect(expert!.dispatch).toBe(true);
    expect(expert!.mcpToolFilter ?? []).toEqual([]);
  });

  it("rpi-domain-expert SKILL.md carries the grounding rule + curated body (grounding guarantee)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const expert = skills.find((s) => s.name === "rpi-domain-expert");
    expect(expert).toBeDefined();
    // Durable grounding: answer ONLY from the curated body, and refuse (don't
    // invent) for anything not covered. Pin the directive + the out-of-scope
    // refusal so a future scrub can't silently weaken it. Updated when the SME
    // V1 body landed — the old "hasn't been authored" empty-body refusal was
    // removed with the interim decline block; the behavioral guard now lives in
    // the converted grounding pair in tests/integration/scenarios.ts.
    expect(expert!.instructions).toContain(
      "Answer **only** from the **Curated knowledge**",
    );
    expect(expert!.instructions).toContain("curated RPI knowledge");
    // body landed (SME V1): a stable anchor proving real curated content is present
    expect(expert!.instructions).toContain("Configuration foundations");
  });

  it("each per-category action skill has an mcpToolFilter", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    for (const name of [
      "rpi-audiences",
      "rpi-interactions",
      "rpi-selection-rules",
      "rpi-folders",
    ]) {
      const skill = skills.find((s) => s.name === name);
      expect(skill).toBeDefined();
      expect(skill!.type).toBe("action");
      expect(skill!.mcpToolFilter?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // ---- Source-pin tests for the skill discipline blocks ----
  //
  // Mirror the `maxRetries: 2` pattern: read
  // SKILL.md body via the loader and assert the load-bearing discipline
  // phrases are present. These phrases were added in response to
  // user-visible behavior bugs captured live on 2026-05-21; if a future
  // scrub silently drops them, the bugs reintroduce. Source-pins fail
  // loudly so the regression surfaces at PR time.

  it("rpi-audiences SKILL.md carries the count-redirect to rpi-selection-rules (Bug C routing fix)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const skill = skills.find((s) => s.name === "rpi-audiences");
    expect(skill).toBeDefined();
    // PRIMARY routing fix: counts are owned by rpi-selection-rules; rpi-audiences
    // must redirect, not attempt. Captured 2026-05-22: same prompt routed to
    // either skill produced wildly different answers because rpi-audiences has
    // no count tool. If a future scrub drops this redirect, the mis-route returns.
    expect(skill!.instructions).toContain("served by the rpi-selection-rules skill");
    expect(skill!.instructions).toContain("Do NOT attempt counts here");
  });

  it("rpi-audiences SKILL.md does NOT carry the stale count-chain guidance (negative assertion)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const skill = skills.find((s) => s.name === "rpi-audiences");
    expect(skill).toBeDefined();
    // An earlier change wrongly guided counts via list_audience_test_instances /
    // get_audience_execution_results — that's RPI test-run history, not
    // current counts. Removed 2026-05-22. The TOOL NAMES themselves
    // legitimately appear in the tool inventory and the historical
    // "List recent test runs" workflow, so the negative assertion
    // targets the COUNT-CHAIN GUIDANCE phrases unique to the deleted
    // Bug A example — not the tool names.
    expect(skill!.instructions).not.toContain("to get counts, then filtering");
    expect(skill!.instructions).not.toContain("Here are the audiences with counts > 0");
    expect(skill!.instructions).not.toContain("hallucinated filter — the data wasn't actually checked");
  });

  it("rpi-audiences SKILL.md carries the anti-hallucinated-filter discipline (Bug A principle)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const skill = skills.find((s) => s.name === "rpi-audiences");
    expect(skill).toBeDefined();
    expect(skill!.instructions).toContain("DO NOT claim filter compliance you didn't verify");
  });

  it("rpi-audiences SKILL.md carries the directive-autonomy discipline (Bug B principle)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const skill = skills.find((s) => s.name === "rpi-audiences");
    expect(skill).toBeDefined();
    expect(skill!.instructions).toContain("EXECUTE the workflow chain");
    expect(skill!.instructions).toContain("don't pause to ask");
  });

  it("rpi-selection-rules frontmatter description OWNS audience counts (PRIMARY routing fix)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const skill = skills.find((s) => s.name === "rpi-selection-rules");
    expect(skill).toBeDefined();
    // Source-pin on `description` (the field the router catalog reads) —
    // load-bearing phrases that drive count-prompt routing here.
    expect(skill!.description).toContain("audience counts");
    expect(skill!.description).toContain("segmentation criterion");
    // SUPERSEDED ASSERTION below — keep for context; the body's polysemy
    // prose was shrunk to defer to the frontmatter. Re-asserting old body
    // phrases here would re-add the redundant prose we just removed.
    expect(skill!.instructions).toContain("counts, waterfalls, or the criteria SQL");
  });

  it("rpi-selection-rules SKILL.md carries the predicate-application discipline (Bug D fix)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const skill = skills.find((s) => s.name === "rpi-selection-rules");
    expect(skill).toBeDefined();
    // Bug D: live 2026-05-22 13:33 trace showed the sub-agent keyword-matching
    // rule NAMES for "Age" and claiming `>20` compliance without verifying
    // criteria. The Bug A discipline went only to rpi-audiences;
    // selection-rules had no anti-hallucination guardrail until this fix.
    // If a future scrub drops these phrases, the name-vs-criterion confusion
    // regresses silently.
    expect(skill!.instructions).toContain("Rule NAME ≠ rule SQL criterion");
    expect(skill!.instructions).toContain("Do NOT claim filter compliance you didn't verify");
    expect(skill!.instructions).toContain("APPLY it");
  });
});
