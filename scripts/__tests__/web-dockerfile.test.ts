/**
 * The images' Node. The web image's Next.js build runs under Node, not Bun: in the
 * oven/bun builder, `node` on PATH is Bun's fallback shim, and Next 16.3's Turbopack
 * build crashes under Bun. The builder copies the runner's Node and calls it by
 * absolute path. The server image runs drizzle-kit under Node at first start.
 *
 * Every Node is the official image's, pinned by digest and at least the security
 * release this line last took — never the distribution's `nodejs`, a release line
 * past its end of life that security releases never reach.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/** The lowest Node an image may carry: the October 2026 security release on 22.x. */
const NODE_FLOOR = [22, 23, 4] as const;

const read = (path: string) => readFileSync(join(import.meta.dir, "../..", path), "utf8");
const instructions = (text: string) => text.split("\n").filter((l) => !l.trimStart().startsWith("#"));
const DIGEST = "@sha256:[0-9a-f]{64}";
const SLIM_COPY = new RegExp(`^COPY --from=node:(\\d+\\.\\d+\\.\\d+)-bookworm-slim${DIGEST} /usr/local/bin/node /usr/local/bin/node$`, "m");

function atLeastFloor(version: string): boolean {
  const v = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (v[i]! !== NODE_FLOOR[i]) return v[i]! > NODE_FLOOR[i]!;
  return true;
}

describe("the web Dockerfile", () => {
  const DOCKERFILE = read("apps/web/Dockerfile");
  const lines = instructions(DOCKERFILE);

  it("runs next build with the copied Node binary", () => {
    const builds = lines.filter((l) => /next( |\/dist\/bin\/next )build/.test(l));
    expect(builds).toEqual(["RUN /usr/local/bin/node ./node_modules/next/dist/bin/next build"]);
  });

  it("copies Node from the runner's Node version, both pinned by digest", () => {
    const copied = DOCKERFILE.match(SLIM_COPY)?.[1];
    const runner = DOCKERFILE.match(new RegExp(`^FROM node:(\\d+\\.\\d+\\.\\d+)-alpine${DIGEST} AS runner$`, "m"))?.[1];
    expect(copied).toBeDefined();
    expect(copied).toBe(runner);
  });

  it(`the Node is at least ${NODE_FLOOR.join(".")}`, () => {
    const copied = DOCKERFILE.match(SLIM_COPY)?.[1];
    expect(copied).toBeDefined();
    expect(atLeastFloor(copied!)).toBe(true);
  });
});

describe("the server Dockerfile", () => {
  const DOCKERFILE = read("apps/server/Dockerfile");
  const lines = instructions(DOCKERFILE);

  it("installs no distribution nodejs", () => {
    const installs = lines.filter((l) => /apt-get install/.test(l));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) expect(l).not.toMatch(/\bnodejs\b/);
  });

  it(`copies the official Node, pinned by digest, at least ${NODE_FLOOR.join(".")}, before bun install`, () => {
    const copy = lines.findIndex((l) => SLIM_COPY.test(l));
    const install = lines.findIndex((l) => /bun install/.test(l));
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(install);
    expect(atLeastFloor(lines[copy]!.match(SLIM_COPY)![1]!)).toBe(true);
  });
});
