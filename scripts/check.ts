#!/usr/bin/env bun
/**
 * bun run check — post-install verifier
 *
 * Runs a small set of high-value invariants against the current install
 * and reports pass/fail per check. Exit 0 if all pass, 1 if any fail.
 *
 * Pass --running to also curl the three health endpoints (server :3000,
 * web :3001, mcp-rpi :3002) — useful after `docker compose up` or
 * `bun run dev` to verify the live stack is actually serving.
 *
 * History: this script was added after a Docker smoke test surfaced a
 * latent bug where `bunx drizzle-kit push` fails inside Bun (better-sqlite3
 * native binding can't be dlopen'd by Bun, only Node). Check 4 below
 * exercises that exact code path (`require('better-sqlite3')` under Node)
 * so the issue shows up in 5 seconds instead of 40 minutes of Docker
 * iteration.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const results: { status: "pass" | "fail" | "skip" | "warn"; line: string }[] = [];

function pass(line: string) {
  results.push({ status: "pass", line });
  console.log(`  \x1b[32m✓\x1b[0m ${line}`);
}
function fail(line: string) {
  results.push({ status: "fail", line });
  console.log(`  \x1b[31m✗\x1b[0m ${line}`);
}
function skip(line: string) {
  results.push({ status: "skip", line });
  console.log(`  \x1b[90m?\x1b[0m ${line}`);
}
function warn(line: string) {
  results.push({ status: "warn", line });
  console.log(`  \x1b[33m!\x1b[0m ${line}`);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const flagRunning = process.argv.includes("--running");

console.log("\nbun run check — verifying install\n");

// ---------------------------------------------------------------------------
// 1. Bun version satisfies engines.bun
// ---------------------------------------------------------------------------

const rootPkgJson = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
);
const requiredBun: string | undefined = rootPkgJson.engines?.bun;
const actualBun = Bun.version;

if (!requiredBun) {
  warn(`No engines.bun declared in root package.json (running Bun ${actualBun})`);
} else {
  // Simple gte check; engine-strict already enforces, this is reporting only.
  // Parse ">=1.3.0" → require major.minor.patch >= 1.3.0
  const m = requiredBun.match(/>=?\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    warn(`engines.bun "${requiredBun}" — non-standard format, skipping comparison`);
  } else {
    const [, rMaj, rMin, rPat] = m.map(Number);
    const [aMaj, aMin, aPat] = actualBun.split(".").map(Number);
    const ok =
      aMaj > rMaj ||
      (aMaj === rMaj && aMin > rMin) ||
      (aMaj === rMaj && aMin === rMin && aPat >= rPat);
    if (ok) {
      pass(`Bun ${actualBun} satisfies engines.bun "${requiredBun}"`);
    } else {
      fail(
        `Bun ${actualBun} does not satisfy engines.bun "${requiredBun}" — upgrade Bun`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. All workspace package.json files parse
// ---------------------------------------------------------------------------

const workspaces: string[] = rootPkgJson.workspaces || [];
const workspaceDirs: string[] = [];
const { readdirSync, statSync } = await import("node:fs");

for (const pattern of workspaces) {
  // Patterns are like "apps/*" or "packages/*". Naive expansion: read dir.
  if (pattern.endsWith("/*")) {
    const parent = join(REPO_ROOT, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const p = join(parent, entry);
      if (statSync(p).isDirectory() && existsSync(join(p, "package.json"))) {
        workspaceDirs.push(p);
      }
    }
  } else {
    const p = join(REPO_ROOT, pattern);
    if (existsSync(join(p, "package.json"))) workspaceDirs.push(p);
  }
}

let parseFailed = false;
for (const dir of workspaceDirs) {
  try {
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (e) {
    fail(`Workspace ${dir.replace(REPO_ROOT + "/", "")} — package.json failed to parse: ${(e as Error).message}`);
    parseFailed = true;
  }
}
if (!parseFailed) {
  pass(`All ${workspaceDirs.length} workspace package.json files parse`);
}

// ---------------------------------------------------------------------------
// 3. Lockfile matches package.json files
// ---------------------------------------------------------------------------

if (!existsSync(join(REPO_ROOT, "bun.lock"))) {
  fail("bun.lock missing — run `bun install` first");
} else {
  const proc = Bun.spawnSync({
    cmd: ["bun", "install", "--frozen-lockfile", "--dry-run"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) {
    pass("bun.lock is in sync with package.json (--frozen-lockfile --dry-run)");
  } else {
    const stderr = new TextDecoder().decode(proc.stderr);
    const firstLine = stderr.split("\n").find((l) => l.includes("error")) || "lockfile drift detected";
    fail(`bun.lock drift: ${firstLine.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Node.js version satisfies engines.node + better-sqlite3 native binding
// ---------------------------------------------------------------------------

const requiredNode: string | undefined = rootPkgJson.engines?.node;
const nodeProbe = spawnSync("node", ["--version"], { encoding: "utf8" });
if (nodeProbe.status !== 0) {
  skip(
    "Node not on PATH — skipping Node version + better-sqlite3 binding check (install Node ≥22.6 to enable)",
  );
} else {
  const actualNode = nodeProbe.stdout.trim().replace(/^v/, "");

  // Node version gate — mirrors the Bun check above. The Next.js frontend
  // AND the TypeScript hooks (--experimental-strip-types) require the
  // engines.node floor. better-sqlite3 loading is necessary but NOT
  // sufficient: a Node 18 box loads the native binding fine yet breaks
  // elsewhere, so without this gate it would pass check silently.
  if (!requiredNode) {
    warn(`No engines.node declared in root package.json (running Node ${actualNode})`);
  } else {
    const nm = requiredNode.match(/>=?\s*(\d+)\.(\d+)\.(\d+)/);
    if (!nm) {
      warn(`engines.node "${requiredNode}" — non-standard format, skipping comparison`);
    } else {
      const [, rMaj, rMin, rPat] = nm.map(Number);
      const [aMaj, aMin, aPat] = actualNode.split(".").map(Number);
      const ok =
        aMaj > rMaj ||
        (aMaj === rMaj && aMin > rMin) ||
        (aMaj === rMaj && aMin === rMin && aPat >= rPat);
      if (ok) {
        pass(`Node ${actualNode} satisfies engines.node "${requiredNode}"`);
      } else {
        fail(
          `Node ${actualNode} does not satisfy engines.node "${requiredNode}" — upgrade Node`,
        );
      }
    }
  }

  const proc = spawnSync(
    "node",
    ["-e", "require('better-sqlite3'); console.log('ok');"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (proc.status === 0 && proc.stdout.trim() === "ok") {
    pass(`better-sqlite3 native binding loads via Node ${actualNode}`);
  } else {
    fail(
      `better-sqlite3 native binding failed to load via Node — ${(proc.stderr || "").split("\n")[0]}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Required env-var sanity (warn-only)
// ---------------------------------------------------------------------------

const envPath = join(REPO_ROOT, ".env");
if (!existsSync(envPath)) {
  warn(".env not found — copy .env.example to .env and fill in values before `bun run dev`");
} else {
  const envText = readFileSync(envPath, "utf8");
  const declared = new Map<string, string>();
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) declared.set(m[1], m[2].trim());
  }
  // Vars that meaningfully change behavior if blank
  const interesting = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AUTH_SECRET",
    "RPI_INTEGRATION_API_URL",
    "RPI_OAUTH_CLIENT_ID",
    "RPI_OAUTH_CLIENT_SECRET",
    "RPI_DEFAULT_CLIENT_ID",
  ];
  // A var copied straight from .env.example (e.g. `sk-ant-...`,
  // `your-oauth-client-id`, `changeme-...`, `<user>`) is non-empty but
  // effectively unset — treat it as blank so a verbatim .env.example copy
  // doesn't pass silently.
  const isPlaceholder = (v: string): boolean => {
    const t = v.trim();
    return (
      t.endsWith("...") ||
      t.startsWith("your-") ||
      t.startsWith("changeme-") ||
      (t.startsWith("<") && t.endsWith(">"))
    );
  };
  const blank = interesting.filter((k) => {
    const v = declared.get(k);
    return !v || isPlaceholder(v);
  });
  if (blank.length === 0) {
    pass(`.env present, all common vars filled in (${declared.size} declarations)`);
  } else {
    warn(
      `.env present but unset/blank/placeholder: ${blank.join(", ")}. ` +
        `LLM provider keys (ANTHROPIC_API_KEY / OPENAI_API_KEY / AZURE_*) are ` +
        `needed for chat. RPI_* vars are needed for RPI tools — without them ` +
        `the MCP server runs in DEGRADED mode (server + web still work).`,
    );
  }

  // Cross-validate AUTH_REQUIRED + AUTH_SECRET. The server refuses to boot
  // in auth-required mode without a real secret (apps/server/src/index.ts);
  // surface that here too so check fails before dev start.
  if (declared.get("AUTH_REQUIRED") === "true") {
    const secret = declared.get("AUTH_SECRET") ?? "";
    if (!secret || secret.startsWith("changeme-")) {
      fail(
        "AUTH_REQUIRED=true but AUTH_SECRET is missing or still the changeme-* placeholder — generate one with `openssl rand -base64 32`",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Type gate — tsc --noEmit across every package (source-only)
// ---------------------------------------------------------------------------

{
  const proc = spawnSync("bun", ["run", "typecheck"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (proc.status === 0) {
    pass("tsc --noEmit clean across all packages (bun run typecheck)");
  } else {
    const out = (proc.stdout || "") + (proc.stderr || "");
    const errCount = (out.match(/error TS\d+/g) || []).length;
    fail(
      `tsc --noEmit found ${errCount} type error(s) — run \`bun run typecheck\` for detail`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Optional --running: curl health endpoints
// ---------------------------------------------------------------------------

if (flagRunning) {
  const endpoints: Array<[string, string]> = [
    ["server", "http://localhost:3000/api/v1/health"],
    ["web", "http://localhost:3001/"],
    ["mcp-rpi", "http://localhost:3002/health"],
  ];
  for (const [name, url] of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        pass(`${name.padEnd(8)} ${url} → HTTP ${res.status}`);
      } else {
        fail(`${name.padEnd(8)} ${url} → HTTP ${res.status}`);
      }
    } catch (e) {
      fail(`${name.padEnd(8)} ${url} → ${(e as Error).message}`);
    }
  }
} else {
  console.log(
    "  \x1b[90m?\x1b[0m Live-stack health checks skipped — pass --running to enable after `docker compose up` or `bun run dev`",
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const pass_ = results.filter((r) => r.status === "pass").length;
const fail_ = results.filter((r) => r.status === "fail").length;
const skip_ = results.filter((r) => r.status === "skip").length;
const warn_ = results.filter((r) => r.status === "warn").length;

console.log(
  `\n  ${pass_} pass / ${fail_} fail / ${skip_} skip / ${warn_} warn\n`,
);

process.exit(fail_ > 0 ? 1 : 0);
