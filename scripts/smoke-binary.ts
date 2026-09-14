/**
 * Standalone MCP-binary smoke — boots a COMPILED MCP server exe from its shipped
 * dist folder with a filled .env and drives the real MCP handshake over HTTP.
 *
 * Why: build:all compiles the rp-{rpi,drh}-mcp-{os} exes + copies templates, but
 * nothing ever RUNTIME-checked them — a binary that can't boot, doesn't load its
 * cwd .env, or exposes zero tools could ship. This is the binary analogue of
 * smoke-bundle.ts.
 *
 * Asserts (against a COPY of the dist folder in a temp dir, launcher-as-shipped):
 *   1. exe boots and binds the .env's port (proves the .env TOOK EFFECT — the
 *      port is a non-default marker, so binding it can't be a default).
 *   2. MCP handshake: initialize → Mcp-Session-Id → notifications/initialized →
 *      tools/list.
 *   3. tools/list count > 0.
 *   4. (fail-loud mode) with SMOKE_EXPECT=fail — e.g. a missing .env or a
 *      backend-disabling config — assert the server does NOT expose tools /
 *      the launcher refuses; a non-failure is itself a failure.
 *
 * Env:
 *   SMOKE_SVC        rpi | drh                          (required)
 *   SMOKE_BIN_DIR    dist folder to smoke               (default: packages/mcp-<svc>/dist/rp-<svc>-mcp-linux-x64)
 *   SMOKE_PORT       marker port for the .env           (default: 39002 rpi / 39003 drh)
 *   SMOKE_ENV_FILE   a .env to drop next to the exe      (optional; else a minimal filled one is written)
 *   SMOKE_NO_ENV     =1 → drop NO .env (missing-.env fail-loud test)
 *   SMOKE_EXPECT     tools | fail                        (default: tools; `fail` = expect 0 tools / no boot)
 *   SMOKE_EXE        exe filename                        (default: rp-<svc>-mcp-linux)
 *   SMOKE_KEEP       =1 → leave the temp dir            (default: cleaned)
 * Exits non-zero on the first failed assertion.
 */
import { spawnSync, spawn, type ChildProcess } from "child_process";
import { mkdtempSync, cpSync, writeFileSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let child: ChildProcess | undefined;
let workDir = "";

const SVC = process.env.SMOKE_SVC;
if (SVC !== "rpi" && SVC !== "drh") fail("SMOKE_SVC must be 'rpi' or 'drh'");

// Opt-out (mirrors SMOKE_BUNDLE_SKIP): this smoke spawns and holds a listening
// server, which some sandboxed shells kill. CI leaves it ON (gates the binary);
// an environment that can't host a listener sets SMOKE_BINARY_SKIP=1. A SKIP is
// announced LOUD, never a silent pass, so an unverified binary can't masquerade.
if (process.env.SMOKE_BINARY_SKIP === "1") {
  console.warn(
    `[binsmoke:${SVC}] SKIPPED (SMOKE_BINARY_SKIP=1) — the ${SVC} binary was NOT runtime-verified this build.`,
  );
  process.exit(0);
}
const REPO = join(import.meta.dir, "..");
const BIN_DIR = process.env.SMOKE_BIN_DIR ?? join(REPO, `packages/mcp-${SVC}/dist/rp-${SVC}-mcp-linux-x64`);
const EXE = process.env.SMOKE_EXE ?? `rp-${SVC}-mcp-linux`;
const PORT = Number(process.env.SMOKE_PORT ?? (SVC === "rpi" ? 39002 : 39003));
const EXPECT = process.env.SMOKE_EXPECT ?? "tools";
const NO_ENV = process.env.SMOKE_NO_ENV === "1";
const KEEP = process.env.SMOKE_KEEP === "1";
const PORT_VAR = SVC === "rpi" ? "RPI_MCP_HTTP_PORT" : "DRH_MCP_HTTP_PORT";
const BASE = `http://127.0.0.1:${PORT}`;

const stage = (m: string) => process.stderr.write(`[binsmoke:${SVC}] … ${m}\n`);

function fail(msg: string): never {
  console.error(`\n[binsmoke:${SVC ?? "?"}] ✗ FAIL: ${msg}\n`);
  cleanup();
  process.exit(1);
}
const ok = (m: string) => console.log(`[binsmoke:${SVC}] ✓ ${m}`);
function cleanup() {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  if (workDir && !KEEP) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ } }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A default-filled .env for the given service (marker port so binding proves .env took effect). */
function defaultEnv(): string {
  const common = `${PORT_VAR}=${PORT}\nAUTH_REQUIRED=false\n`;
  if (SVC === "rpi") {
    return (
      common +
      "RPI_INTEGRATION_API_URL=https://binsmoke-marker.example.com/\n" +
      "RPI_OAUTH_CLIENT_ID=binsmoke\nRPI_OAUTH_CLIENT_SECRET=binsmoke\n" +
      "RPI_DEFAULT_CLIENT_ID=00000000-0000-0000-0000-000000000000\nRPI_PROXY_ENABLED=false\n"
    );
  }
  return (
    common +
    "DRH_API_URL=https://binsmoke-marker.example.com/\nDRH_DEFAULT_CLIENT_ID=binsmoke-client\n" +
    "DRH_DEFAULT_DATABASE_ID=\nDRH_PROXY_USER=svc\nDRH_PROXY_PASS=svc\nDRH_PROXY_ENABLED=true\n"
  );
}

/** POST one JSON-RPC message; return { status, sessionId, body }. Parses SSE `data:` or plain JSON. */
async function rpc(body: unknown, sessionId?: string): Promise<{ status: number; sessionId?: string; text: string }> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, sessionId: res.headers.get("mcp-session-id") ?? undefined, text: await res.text() };
}

/** Pull the JSON-RPC result object out of an SSE-or-plain body. */
function parseRpc(text: string): any {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
  const json = line ? line.slice(5).trim() : text.trim();
  try { return JSON.parse(json); } catch { return null; }
}

async function main() {
  if (!existsSync(join(BIN_DIR, EXE))) fail(`exe not found: ${join(BIN_DIR, EXE)} — build it first (build:all)`);

  // Sweep any binsmoke-* temp dirs a PRIOR run leaked (a SIGTERM-killed run skips
  // cleanup()). Best-effort; these live under the OS temp dir, never dist/.
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith("binsmoke-")) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  } catch { /* best-effort */ }

  // Fresh temp copy of the shipped folder — never smoke in dist/ itself.
  stage("creating temp dir");
  workDir = mkdtempSync(join(tmpdir(), `binsmoke-${SVC}-`));
  stage(`copying ${BIN_DIR} -> ${workDir}`);
  cpSync(BIN_DIR, workDir, { recursive: true });
  stage("copied; writing .env + spawning exe");
  if (!NO_ENV) {
    const envText = process.env.SMOKE_ENV_FILE
      ? spawnSync("cat", [process.env.SMOKE_ENV_FILE], { encoding: "utf8" }).stdout
      : defaultEnv();
    writeFileSync(join(workDir, ".env"), envText);
  }

  // Boot the exe directly (the launcher just cd's + execs it; we assert the exe).
  child = spawn(join(workDir, EXE), [], { cwd: workDir, stdio: ["ignore", "pipe", "pipe"], detached: false });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code));
  stage(`spawned pid ${child.pid}; polling ${BASE}/health`);

  // 1. boot + bind the marker port
  let up = false;
  for (let i = 0; i < 30; i++) {
    if (exited !== null) break;
    try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(1000);
  }

  if (EXPECT === "fail") {
    // Fail-loud path: no .env (or a boot-blocking config) must NOT yield a working toolful server.
    if (!up) { ok(`fail-loud: server did not come up on ${BASE} (as expected). log: ${log.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`); cleanup(); process.exit(0); }
    // It came up — then it must expose ZERO tools, else the bad-config guard failed.
    const count = await toolsCount().catch(() => -1);
    if (count > 0) fail(`fail-loud expected 0 tools but got ${count} — a bad/missing .env still produced a toolful server`);
    ok(`fail-loud: server up but exposed ${count} tools (backend correctly disabled)`);
    cleanup(); process.exit(0);
  }

  if (!up) fail(`exe did not answer /health on the .env's port ${PORT} within 30s (exit=${exited}). log: ${log.trim().slice(-400)}`);
  ok(`exe booted + bound the .env marker port ${PORT} (${PORT_VAR}) — .env took effect`);

  // 2+3. handshake + tools count
  const count = await toolsCount();
  if (count <= 0) fail(`tools/list returned ${count} tools — handshake/registration is dead`);
  ok(`MCP handshake OK (initialize → session → notifications/initialized → tools/list); tools=${count}`);

  console.log(`\n[binsmoke:${SVC}] ✓ PASS — ${EXE} boots, loads .env, serves ${count} tools.\n`);
  cleanup();
  process.exit(0);
}

async function toolsCount(): Promise<number> {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "binsmoke", version: "1" } } });
  const sid = init.sessionId;
  if (!sid) throw new Error(`initialize returned no Mcp-Session-Id (status ${init.status})`);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid);
  const parsed = parseRpc(list.text);
  const tools = parsed?.result?.tools;
  return Array.isArray(tools) ? tools.length : 0;
}

main().catch((e) => fail(`unexpected error: ${e?.message ?? e}`));
