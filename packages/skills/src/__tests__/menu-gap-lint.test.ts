/**
 * Menu-gap lint — a required tool the router can hide behind an operation is a
 * build failure, not a nightly flake.
 *
 * Pattern A narrows a sub-agent's tools to the operation the router passes. If the
 * router picks an op whose menu lacks the tool a prompt needs (an "op attractor"),
 * the sub-agent can't call it. Each tool-pinned scenario on a skill with operations
 * carries `routedOps` (scenarios.ts): the ops the router has been seen to pass for
 * that prompt. This lint holds the required tool in every one of them. The routing
 * eval's tripwire (`menuGapTrips`) covers ops not yet seen.
 */
import { describe, it, expect } from "bun:test";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadSkillsFromDirectory } from "../loader.js";
import {
  DRH_SCENARIOS,
  SCENARIOS,
  menuGapTrips,
  menuHoldsTool,
} from "../../../../tests/integration/scenarios.js";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../skills");
const skills = await loadSkillsFromDirectory(SKILLS_DIR);
const OPS = Object.fromEntries(skills.map((s) => [s.name, s.operations])) as Record<
  string,
  Record<string, string[]> | undefined
>;
const ALL = [...SCENARIOS, ...DRH_SCENARIOS];
const pinnedOnOpSkill = ALL.filter(
  (sc) => sc.expectedToolNamePattern && sc.expectedSkill && OPS[sc.expectedSkill],
);

describe("menu-gap lint — routedOps (tests/integration/scenarios.ts)", () => {
  it("every tool-pinned scenario on a skill with operations seeds routedOps", () => {
    expect(pinnedOnOpSkill.filter((sc) => !sc.routedOps).map((sc) => sc.id)).toEqual([]);
  });

  it("routedOps appears only on a tool-pinned scenario whose skill declares operations", () => {
    expect(ALL.filter((sc) => sc.routedOps && !pinnedOnOpSkill.includes(sc)).map((sc) => sc.id)).toEqual([]);
  });

  it("every routedOps op is one its skill declares, listed once", () => {
    const bad: string[] = [];
    for (const sc of pinnedOnOpSkill) {
      const menus = OPS[sc.expectedSkill!]!;
      const ops = sc.routedOps ?? [];
      if (new Set(ops).size !== ops.length) bad.push(`${sc.id}: duplicate op in ${JSON.stringify(ops)}`);
      for (const op of ops) if (!Object.hasOwn(menus, op)) bad.push(`${sc.id}: ${sc.expectedSkill} declares no op "${op}"`);
    }
    expect(bad).toEqual([]);
  });

  it("every routedOps op's menu holds the scenario's required tool", () => {
    const gaps: string[] = [];
    for (const sc of pinnedOnOpSkill) {
      const menus = OPS[sc.expectedSkill!]!;
      for (const op of sc.routedOps ?? []) {
        if (Object.hasOwn(menus, op) && !menuHoldsTool(sc.expectedToolNamePattern!, menus[op]!)) {
          gaps.push(`${sc.id}: op "${op}" of ${sc.expectedSkill} lacks ${sc.expectedToolNamePattern}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });
});

describe("menu-gap tripwire — menuGapTrips", () => {
  const sc = { expectedSkill: "s", expectedToolNamePattern: /^rpi__want$/ };
  const ops = { s: { has: ["want", "other"], lacks: ["other"] } };

  it("trips on a declared op whose menu lacks the required tool, and names it", () => {
    expect(menuGapTrips(sc, [{ skillName: "s", operation: "lacks" }], ops)).toEqual([
      `router chose op "lacks" for s; "lacks"'s menu lacks /^rpi__want$/`,
    ]);
  });

  it("stays quiet on a declared op holding the tool, an undeclared op, no op, or another skill", () => {
    expect(
      menuGapTrips(
        sc,
        [
          { skillName: "s", operation: "has" },
          { skillName: "s", operation: "made-up" },
          { skillName: "s", operation: "constructor" },
          { skillName: "s" },
          { skillName: "t", operation: "lacks" },
        ],
        ops,
      ),
    ).toEqual([]);
  });

  it("stays quiet when the scenario pins no tool or its skill declares no operations", () => {
    const d = [{ skillName: "s", operation: "lacks" }];
    expect(menuGapTrips({ expectedSkill: "s", expectedToolNamePattern: undefined }, d, ops)).toEqual([]);
    expect(menuGapTrips(sc, d, { s: undefined })).toEqual([]);
  });
});
