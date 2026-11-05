/**
 * Sync guard for the mirrored budgets: lib/rate-limit.ts, lib/validation-guard.ts and
 * lib/serve-mode.ts are the RPI MCP server's packages/mcp-rpi/src/{rate-limit,
 * validation-guard,serve-mode}.ts (in this repo) — identical code apart from the
 * header comment and import lines. The MCP server is a standalone binary with no
 * shared package, so the app server keeps its own copies.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const readTree = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\r\n?/g, "\n");

/** The CODE of a mirrored file: without its leading header comment and import lines. */
function mirrorCode(src: string): string {
  const s = src.trimStart();
  const body = s.startsWith("/**") ? s.slice(s.indexOf("*/") + 2) : s;
  return body
    .split("\n")
    .filter((l) => !/^import\s/.test(l))
    .join("\n")
    .trim();
}

/** The names a module exports (from its source text). */
function exportNames(src: string): string[] {
  return [...src.matchAll(/^export (?:async )?(?:function|const|class|let|type|interface) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]!).sort();
}

const PAIRS = [
  ["apps/server/src/lib/rate-limit.ts", "packages/mcp-rpi/src/rate-limit.ts"],
  ["apps/server/src/lib/validation-guard.ts", "packages/mcp-rpi/src/validation-guard.ts"],
  ["apps/server/src/lib/serve-mode.ts", "packages/mcp-rpi/src/serve-mode.ts"],
] as const;

describe.each(PAIRS)("%s mirrors %s", (mine, source) => {
  it("names the MCP server's file as its source", () => {
    expect(readTree(mine)).toContain(`MIRROR of ${source}`);
  });
  it("the code is identical (apart from the header comment and imports)", () => {
    expect(mirrorCode(readTree(mine))).toBe(mirrorCode(readTree(source)));
  });
  it("exports the same surface", () => {
    expect(exportNames(readTree(mine))).toEqual(exportNames(readTree(source)));
  });
});
