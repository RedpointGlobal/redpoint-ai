/**
 * Docker-bundle smoke test — exercises the REP PATH end-to-end through the WEB
 * entry point (never a direct server POST), on the bundle's default ports.
 *
 * Why the web entry point: an earlier smoke POSTed the server container directly
 * (localhost:3000), bypassing the exact path a browser/rep takes — the web app's
 * proxy route → server → mcp → rpi across the container network. That let a
 * server-side `no such table` 500 (invisible to a direct-server test on a
 * different code path) ship green. This drives the web proxy so any dead hop in
 * web→server→mcp→rpi fails LOUD.
 *
 * Phases (each fails the run on first failed assertion):
 *   1. UI       — web serves the app page.
 *   2. VERSION  — server /health status ok AND version == packages/shared/version.json.
 *   3. AUTH     — when the bundle ships auth=true, drive the real NextAuth native
 *                 login (CSRF → /api/auth/callback/rpi-native) and assert a
 *                 session cookie is issued. Under auth=false, skipped.
 *   4. CHAIN    — POST a prompt through the WEB proxy (authed if step 3 ran):
 *                 200 AND a real tool call in the stream (execute_skill + rpi__*).
 *   5. DASHBOARD (opt, --dashboard) — the daily dashboard pill returns a
 *                 render_dashboard call (best-effort panel-count check logged).
 *
 * Lifecycle knobs (env):
 *   SMOKE_COMPOSE_FILE  compose to bring up (required unless SMOKE_NO_LIFECYCLE=1)
 *   SMOKE_ENV_FILE      env file for compose up AND the source of login creds
 *   SMOKE_NO_LIFECYCLE  =1 → assert against an already-running stack; skip up/down
 *   SMOKE_KEEP_UP       =1 → leave the stack up after a pass (default: tear down)
 *   SMOKE_DOCKER        docker CLI (default "docker"; e.g. "docker.exe" for Docker Desktop)
 *   SMOKE_PROJECT       compose project name (default "rpai-smoke")
 *   SMOKE_WEB/SMOKE_SERVER  base URLs (default http://127.0.0.1:3001 / :3000)
 *   SMOKE_LOGIN_USER/SMOKE_LOGIN_PASS  native-login creds (default: RPI_PROXY_USER/PASS from SMOKE_ENV_FILE)
 * Flags (argv): --dashboard
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const WEB = process.env.SMOKE_WEB ?? "http://127.0.0.1:3001";
const SERVER = process.env.SMOKE_SERVER ?? "http://127.0.0.1:3000";
const DOCKER = process.env.SMOKE_DOCKER ?? "docker";
const PROJECT = process.env.SMOKE_PROJECT ?? "rpai-smoke";
const COMPOSE_FILE = process.env.SMOKE_COMPOSE_FILE;
const ENV_FILE = process.env.SMOKE_ENV_FILE;
const NO_LIFECYCLE = process.env.SMOKE_NO_LIFECYCLE === "1";
const KEEP_UP = process.env.SMOKE_KEEP_UP === "1";
const WANT_DASHBOARD = process.argv.includes("--dashboard");

const version = (
  JSON.parse(
    readFileSync(join(import.meta.dir, "..", "packages", "shared", "version.json"), "utf8"),
  ) as { version: string }
).version;

/** Read a KEY from the SMOKE_ENV_FILE (for default login creds), or "". */
function envFileValue(key: string): string {
  if (!ENV_FILE) return "";
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const m = line.match(new RegExp(`^${key}=(.*)$`));
      if (m) return m[1].trim();
    }
  } catch { /* no env file */ }
  return "";
}

function fail(msg: string): never {
  console.error(`\n[smoke] ✗ FAIL: ${msg}\n`);
  if (!NO_LIFECYCLE && !KEEP_UP) composeDown();
  process.exit(1);
}
const ok = (msg: string) => console.log(`[smoke] ✓ ${msg}`);

function compose(args: string[]) {
  const base = ["compose", "-p", PROJECT, "-f", COMPOSE_FILE!];
  if (ENV_FILE) base.push("--env-file", ENV_FILE);
  return spawnSync(DOCKER, [...base, ...args], { stdio: "inherit" });
}
function composeDown() {
  if (COMPOSE_FILE) compose(["down", "--remove-orphans"]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, label: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  fail(`${label} did not answer at ${url} within ${tries * 2}s`);
}

/** NextAuth native login → returns a Cookie header string, or fail. */
async function nativeLogin(): Promise<string> {
  const user = process.env.SMOKE_LOGIN_USER || envFileValue("RPI_PROXY_USER");
  const pass = process.env.SMOKE_LOGIN_PASS || envFileValue("RPI_PROXY_PASS");
  if (!user || !pass) fail("auth=true but no login creds (SMOKE_LOGIN_USER/PASS or RPI_PROXY_USER/PASS in env file)");

  const csrfRes = await fetch(`${WEB}/api/auth/csrf`, { signal: AbortSignal.timeout(8000) });
  const setCookies: string[] = [];
  const csrfCookie = csrfRes.headers.getSetCookie?.() ?? [];
  setCookies.push(...csrfCookie);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");

  const form = new URLSearchParams({
    csrfToken,
    username: user,
    password: pass,
    callbackUrl: `${WEB}/`,
  });
  const loginRes = await fetch(`${WEB}/api/auth/callback/rpi-native`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader },
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const loginCookies = loginRes.headers.getSetCookie?.() ?? [];
  const session = [...setCookies, ...loginCookies]
    .map((c) => c.split(";")[0])
    .filter((c) => /session-token/.test(c))
    .join("; ");
  if (!session) fail(`native login did not issue a session cookie (HTTP ${loginRes.status}) — the authed per-user path is broken`);
  ok(`native login succeeded (user "${user}", session cookie issued)`);
  // Return the full cookie jar (csrf + session) for subsequent authed calls.
  return [...setCookies, ...loginCookies].map((c) => c.split(";")[0]).join("; ");
}

/** Resolve the RPI workspace id via a container DB read (test setup only). */
function resolveRpiWorkspaceId(): string {
  const svc = `${PROJECT}-server-1`;
  const script =
    'bun -e "const{Database}=require(\\"bun:sqlite\\");const db=new Database(process.env.DB_FILE_NAME);const r=db.query(\\"select id,name from workspaces\\").all();const w=r.find(x=>/Interaction/.test(x.name))||r[0];process.stdout.write(w?w.id:\\"\\")"';
  const r = spawnSync(DOCKER, ["exec", svc, "sh", "-lc", script], { encoding: "utf8" });
  const id = (r.stdout ?? "").trim();
  if (!id) fail(`could not resolve a workspace id from ${svc} (${(r.stderr ?? "").trim().slice(0, 200)})`);
  return id;
}

async function chatThroughProxy(wsId: string, cookie: string, text: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const res = await fetch(`${WEB}/api/proxy/chat/${wsId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({
      id: "smoke",
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  if (!NO_LIFECYCLE) {
    if (!COMPOSE_FILE) fail("SMOKE_COMPOSE_FILE is required (or set SMOKE_NO_LIFECYCLE=1)");
    console.log(`[smoke] bringing up stack (${PROJECT}) ...`);
    const up = compose(["up", "-d"]);
    if (up.status !== 0) fail(`docker compose up failed (exit ${up.status})`);
  }

  // 1. UI serves
  await waitFor(`${WEB}/`, "web UI");
  const root = await fetch(`${WEB}/`, { signal: AbortSignal.timeout(5000) });
  if (!root.ok || !/<title>[^<]*RedpointAI/i.test(await root.text())) {
    fail(`web UI did not serve the app page (status ${root.status})`);
  }
  ok("web UI serves the app page");

  // 2. version stamp
  const health = await fetch(`${SERVER}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
  const hj = (await health.json().catch(() => ({}))) as { status?: string; version?: string };
  if (!health.ok || hj.status !== "ok") fail(`server health not ok (status ${health.status})`);
  if (hj.version !== version) fail(`version stamp mismatch: health="${hj.version}" expected="${version}"`);
  ok(`server healthy, version stamp = ${hj.version}`);

  // 3. auth — real login when the bundle ships auth=true
  const authRes = await fetch(`${WEB}/api/auth-mode`, { signal: AbortSignal.timeout(5000) });
  const authRequired = ((await authRes.json().catch(() => ({}))) as { authRequired?: boolean }).authRequired === true;
  let cookie = "";
  if (authRequired) {
    ok("bundle ships auth=true (login required) — driving the real login flow");
    cookie = await nativeLogin();
  } else {
    ok("bundle ships auth=false (no login) — skipping login phase");
  }

  // 4. full chain through the web proxy (authed if step 3 ran)
  const wsId = resolveRpiWorkspaceId();
  console.log(`[smoke] driving a prompt through the web proxy (web→server→mcp→rpi)${authRequired ? " as the logged-in user" : ""} ...`);
  const chat = await chatThroughProxy(wsId, cookie, "Check my RPI connection. Use your tools.", 120000);
  if (chat.status !== 200) {
    fail(`web→backend chain returned HTTP ${chat.status} (a broken hop — e.g. a missing-table 500, or an authed-path failure — surfaces here). Body: ${chat.body.slice(0, 300)}`);
  }
  if (!/execute_skill/.test(chat.body) || !/rpi__[a-z_]+/.test(chat.body)) {
    fail(`chain returned 200 but NO real tool call (execute_skill / rpi__*) — orchestrator→skill→mcp path is dead. Body: ${chat.body.slice(0, 300)}`);
  }
  ok(`full chain: web proxy → execute_skill → rpi__* MCP tool (200 + real tool call)${authRequired ? ", via the authed per-user path" : ""}`);

  // 5. dashboard (optional)
  if (WANT_DASHBOARD) {
    console.log("[smoke] driving the daily dashboard pill (slow grind) ...");
    const dash = await chatThroughProxy(
      wsId,
      cookie,
      "Run daily interaction dashboard for last month across all interactions.",
      220000,
    );
    if (dash.status !== 200 || !/render_dashboard/.test(dash.body)) {
      fail(`dashboard pill did not produce a render_dashboard call (HTTP ${dash.status}). Body: ${dash.body.slice(0, 300)}`);
    }
    const panels = (dash.body.match(/"type":"(bar|area|line|donut|pie)"/g) ?? []).length;
    ok(`dashboard rendered (render_dashboard emitted; ~${panels} chart panel(s) seen)`);
  }

  console.log(`\n[smoke] ✓ PASS — rep path healthy on default ports (${WEB})${authRequired ? " with auth=true" : ""}.\n`);
  if (!NO_LIFECYCLE && !KEEP_UP) composeDown();
  process.exit(0);
}

main().catch((e) => fail(`unexpected error: ${e?.message ?? e}`));
