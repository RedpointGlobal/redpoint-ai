#!/usr/bin/env bun
/**
 * Isolated server-package test runner.
 *
 * WHY: Bun's `mock.module()` is process-global AND cannot be undone — in this
 * bun `mock.restore()` does NOT clear a module mock (verified with a probe).
 * So any test file that `mock.module("../store/db.js", ...)` leaks that db
 * replacement into every OTHER test file discovered in the same `bun test`
 * process. The leak is file-DISCOVERY-ORDER dependent (last-registered wins),
 * which is why the plain `bun test` passed on /mnt/c but broke on ext4/CI
 * (fresh /tmp clone): a real-db test (auth-middleware, seed-migration) that ran
 * after a db-mocking file got the mock and threw / mis-asserted. The mockers
 * even conflict with EACH OTHER (seed-provider mocks `db: {}`, workspaces mocks
 * a functional testDb), so they can't share a process either.
 *
 * FIX: run EACH file that calls `mock.module(` in its OWN bun process, and run
 * every other file (including the real-db tests) together in a single process
 * (no db mock present → real db → deterministic). Per the repo's CLAUDE.md,
 * per-file `bun test <file>` is the safe, leak-free invocation. Auto-partitions
 * by scanning for `mock.module(`, so it self-maintains as tests are added.
 *
 * Wired as the server package's `test` script, so the canonical `bun run test`
 * (and the cold cycle) get deterministic, order-independent server tests.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = "src/__tests__";

function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findTestFiles(full));
    else if (name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = findTestFiles(ROOT).sort();
const mockers = files.filter((f) => readFileSync(f, "utf8").includes("mock.module("));
const grouped = files.filter((f) => !mockers.includes(f));

console.error(
  `[test-isolated] ${files.length} test files: ` +
    `${grouped.length} grouped (no db/module mock) + ${mockers.length} isolated (mock.module).`,
);

let anyFailed = false;
function run(label: string, args: string[]): void {
  console.error(`\n[test-isolated] ── ${label} ──`);
  const proc = Bun.spawnSync(["bun", "test", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    // Preserve the caller's env (AUTH_REQUIRED, RPI creds, etc.).
    env: process.env,
  });
  if (proc.exitCode !== 0) anyFailed = true;
}

// Everything without a module mock — real-db tests included — runs together.
if (grouped.length > 0) {
  run(`grouped (${grouped.length} files)`, grouped);
}
// Each module-mocking file runs alone so its process-global mock can't leak.
for (const m of mockers) {
  run(`isolated · ${m}`, [m]);
}

process.exit(anyFailed ? 1 : 0);
