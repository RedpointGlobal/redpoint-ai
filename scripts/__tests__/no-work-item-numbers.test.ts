/**
 * The tree ships public: comments, test titles and the routing eval's scenario
 * notes say what they mean in plain words, never by a work-item number
 * (#NNNN / #NNNNN), a teammate's nickname, or a person's name as the source of a
 * decision. CHANGELOG.md is history and stays out of scope.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO = join(import.meta.dir, "../..");

// Each pattern is spelled so its own line here doesn't match it.
const CHECKS: Record<string, string[]> = {
  "work-item number": ["-E", "#[0-9]{4,5}\\b"],
  "teammate nickname": ["-w", "-i", "-E", "cu[z]"],
  // Attribution forms only (case-sensitive): the verb at a sentence start, and
  // mark / markdown / benchmark, don't match.
  "decision credited to a person": ["-E", "(by|per|to|with) M[a]rk\\b|\\bM[a]rk's\\b|\\(M[a]rk\\b|\\bM[a]rk-[a-z]"],
};

function hits(args: string[]): string[] {
  const r = spawnSync("git", ["grep", "-n", ...args, "--", ":!CHANGELOG.md"], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git grep failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((h) => h.slice(0, 120));
}

describe("the tracked tree", () => {
  for (const [name, args] of Object.entries(CHECKS)) {
    it(`names no ${name}`, () => {
      expect(hits(args)).toEqual([]);
    });
  }
});
