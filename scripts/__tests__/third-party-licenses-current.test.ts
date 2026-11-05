/**
 * THIRD-PARTY-LICENSES.md ships with the source and must list the dependencies
 * this tree actually installs. It is generated (`bun run licenses`), so a
 * dependency change that skips the regeneration leaves it stale. This runs the
 * generator's --check, which fails unless the committed file matches what it
 * would write now.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO = join(import.meta.dir, "../..");

describe("THIRD-PARTY-LICENSES.md", () => {
  it("is current with the installed dependencies (bun run licenses)", () => {
    const r = spawnSync("bun", ["run", "scripts/generate-third-party-licenses.ts", "--check"], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(`${r.stdout}${r.stderr}`.trim()).toContain("is up to date");
    expect(r.status).toBe(0);
  }, 60_000);
});
