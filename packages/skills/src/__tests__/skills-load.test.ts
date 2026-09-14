/**
 * Regression test: every SKILL.md shipped under the repo-root `skills/`
 * directory must parse successfully against the loader's Zod schema.
 *
 * The other loader tests use synthetic fixtures and exercise the parser; this
 * one runs the parser against the real files.
 *
 * It asserts the EXACT shipped set, not a count. loadSkillsFromDirectory()
 * catches a malformed SKILL.md, logs it, and CONTINUES (loader.ts) — so a
 * broken frontmatter file is silently skipped, and any assertion based on
 * `length > 0` or a partial name list stays green while the skill vanishes.
 * Nine of the fifteen shipped skills had no assertion anywhere before this.
 *
 * Exact equality also means adding a skill fails here until the list is
 * updated: shipping a new skill should be a deliberate edit, not a silent one.
 */
import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadSkillsFromDirectory } from "../loader.js";

const __testsDir = dirname(fileURLToPath(import.meta.url));
// packages/skills/src/__tests__ → repo root is 4 levels up
const SKILLS_DIR = join(__testsDir, "../../../../skills");

/**
 * Every skill shipped under skills/ (including skills/experts/). Update this
 * list deliberately when adding or removing one — that is the point.
 */
const EXPECTED_SKILLS = [
  "drh-data-quality",
  "drh-datasources",
  "drh-domain-expert",
  "drh-feeds",
  "drh-foundation-expert",
  "drh-runs",
  "drh-schedules",
  "rpi-admin",
  "rpi-analysis",
  "rpi-attributes",
  "rpi-audiences",
  "rpi-clients",
  "rpi-cluster-infra",
  "rpi-cluster-users",
  "rpi-content",
  "rpi-databases",
  "rpi-decision-rules",
  "rpi-domain-expert",
  "rpi-folders",
  "rpi-foundation-expert",
  "rpi-health",
  "rpi-integrations",
  "rpi-interactions",
  "rpi-operations",
  "rpi-selection-rules",
  "rpi-single-customer-view",
  "rpi-users-permissions",
  "rpi-workflows",
] as const;

describe("repo skills/ directory", () => {
  it("exists at the expected repo-root path", () => {
    expect(existsSync(SKILLS_DIR)).toBe(true);
  });

  it("loads exactly the shipped skill set — every SKILL.md, by name", async () => {
    // Equality, not a count: the loader skips a file it cannot parse, so a
    // count or a partial list cannot tell "loaded fine" from "silently gone".
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    expect(skills.map((s) => s.name).sort()).toEqual([...EXPECTED_SKILLS].sort());
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

  it("rpi-domain-expert SKILL.md has the curated body; grounding contract is NOT duplicated in-file (injected at dispatch)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const expert = skills.find((s) => s.name === "rpi-domain-expert");
    expect(expert).toBeDefined();
    // Phase 2: the grounding contract (answer-only-from-body / refuse-if-uncovered,
    // H6 adjacency + multi-part guards) no longer lives in this file — it's the
    // shared GROUNDING_PREAMBLE, prepended at dispatch in router.ts and pinned in
    // grounding-preamble.test.ts. This test now guards (a) that real curated
    // content is present and (b) that the block was NOT re-authored back into the
    // SKILL.md (which would re-introduce the drift Phase 2 removed).
    expect(expert!.instructions).toContain("Configuration foundations");
    expect(expert!.instructions).not.toContain("## Grounding rule");
    expect(expert!.instructions).not.toContain(
      "Answer **only** from the **Curated knowledge**",
    );
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

  // ---- Structural guard for the v7.60 connection-check fix ----
  //
  // The connection-check 403 (a non-admin asking "Check my RPI connection" got
  // routed with operation="diagnostics", which — before the fix — did NOT
  // include verify_connection, so the sub-agent fell to the cluster error-log
  // tool and 403'd). The fix makes verify_connection a member of EVERY rpi-admin
  // operation: whichever operation the router LLM guesses, the low-privilege
  // per-user connectivity tool is always in the sub-agent's toolset.
  //
  // That invariant was guarded ONLY by the probabilistic check-connection eval —
  // the same green-but-wrong class of guard that hid the original 403. This is
  // the deterministic backstop: it reads the ACTUAL shipped rpi-admin front-matter
  // and fails loudly if verify_connection is dropped from any operation, at PR
  // time, with no LLM in the loop.
  it("rpi-admin: verify_connection is in EVERY operation (v7.60 connection-fix invariant)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const admin = skills.find((s) => s.name === "rpi-admin");
    expect(admin).toBeDefined();
    // Must actually declare operations — an empty/absent map would let the
    // per-operation assertion below pass vacuously.
    expect(admin!.operations).toBeDefined();
    const ops = Object.entries(admin!.operations!);
    expect(ops.length).toBeGreaterThan(0);
    // Every operation — identity, auth, diagnostics, and any future one — must
    // list verify_connection. A missing member here reintroduces the 403.
    for (const [name, tools] of ops) {
      expect(tools, `operation "${name}" must include verify_connection`).toContain(
        "verify_connection",
      );
    }
  });
});
