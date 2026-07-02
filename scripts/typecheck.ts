#!/usr/bin/env bun
/**
 * bun run typecheck — run `tsc --noEmit` across every workspace package.
 *
 * The repo is a TS app, but for a long time nothing actually ran `tsc` (a broken
 * `bun-types` reference silently disabled type resolution, hiding hundreds of
 * latent errors). This is the gate that keeps the source type-clean. It is
 * source-only — each package's tsconfig `exclude`s tests and the generated
 * vendored types carry `@ts-nocheck`.
 *
 * Exits 0 only if every package is error-free; non-zero (with the offending
 * package output) otherwise. Wired into `bun run check`.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Order: leaf packages first, then the apps that consume them.
const PROJECTS = [
  "packages/shared",
  "packages/skills",
  "packages/mcp-rpi",
  "apps/server",
  "apps/web",
];

let failed = 0;
console.log("\ntypecheck — tsc --noEmit per package\n");

for (const proj of PROJECTS) {
  const res = spawnSync(
    "bunx",
    ["tsc", "--noEmit", "-p", join(proj, "tsconfig.json")],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const out = (res.stdout || "") + (res.stderr || "");
  const errCount = (out.match(/error TS\d+/g) || []).length;
  if (res.status === 0 && errCount === 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${proj}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${proj} — ${errCount} error(s)`);
    // Surface the first lines so the failure is actionable.
    console.log(
      out
        .split("\n")
        .filter((l) => l.includes("error TS"))
        .slice(0, 20)
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }
}

console.log(
  failed === 0
    ? `\n  all ${PROJECTS.length} packages type-clean\n`
    : `\n  ${failed} package(s) with type errors\n`,
);
process.exit(failed > 0 ? 1 : 0);
