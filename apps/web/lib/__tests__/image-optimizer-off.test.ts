/**
 * The image optimizer stays off: /_next/image fetches any same-origin path and
 * decodes the bytes it gets back, and the app has no use for it (no next/image).
 * With images.unoptimized the route is a 404 before anything is fetched.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const WEB = join(import.meta.dir, "../..");

describe("the image optimizer", () => {
  it("is off in next.config.ts", () => {
    const config = readFileSync(join(WEB, "next.config.ts"), "utf8");
    expect(config).toMatch(/\n  images: \{ unoptimized: true \},\n/);
  });

  it("has no user in the app (nothing imports next/image)", () => {
    const r = spawnSync("git", ["grep", "-n", "-E", "from [\"']next/(image|legacy/image)[\"']", "--", "."], { cwd: WEB, encoding: "utf8" });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git grep failed: ${r.stderr}`);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([]);
  });
});
