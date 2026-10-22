/**
 * The Bun in every image: the server image runs on it, and the MCP servers' images run
 * binaries it compiled, and a compiled binary carries its Bun's own CA bundle. Bun
 * 1.3.12 still trusted emSign ECC Root CA - G3, which the Mozilla root store removed
 * after the CA's signing key was compromised; 1.4.4 is the first Bun whose bundle drops
 * it. This holds every oven/bun stage at or above that Bun, pinned by digest.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/** The first Bun whose bundled CA store no longer trusts emSign ECC Root CA - G3. */
const BUN_FLOOR = [1, 4, 4] as const;

const DOCKERFILES = ["apps/server/Dockerfile", "apps/web/Dockerfile", "packages/mcp-rpi/Dockerfile", "packages/mcp-drh/Dockerfile"];
const BUN_FROM = /^FROM oven\/bun:(\d+)\.(\d+)\.(\d+)(?:-[a-z]+)?@sha256:[0-9a-f]{64}(?: AS \w+)?$/;

function atLeast(v: number[], floor: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (v[i]! !== floor[i]) return v[i]! > floor[i]!;
  return true;
}

describe("the pinned Bun", () => {
  for (const path of DOCKERFILES) {
    it(`${path}: every oven/bun stage is digest-pinned and at least ${BUN_FLOOR.join(".")}`, () => {
      const text = readFileSync(join(import.meta.dir, "..", "..", path), "utf8");
      const stages = text.split("\n").filter((l) => /^FROM oven\/bun/.test(l));
      expect(stages.length).toBeGreaterThan(0);
      for (const line of stages) {
        const m = line.match(BUN_FROM);
        expect(m).not.toBeNull();
        expect(atLeast([Number(m![1]), Number(m![2]), Number(m![3])], BUN_FLOOR)).toBe(true);
      }
    });
  }
});
