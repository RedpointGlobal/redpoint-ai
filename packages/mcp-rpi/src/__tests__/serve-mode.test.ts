/**
 * How every listener is served (../serve-mode.ts), whatever the environment says:
 *   - production mode: the standalone executables carry no NODE_ENV, and Bun.serve's
 *     `development` defaults to true without NODE_ENV=production. In development mode
 *     an uncaught error in `fetch` is answered with Bun's error page, which embeds the
 *     error's message and stack (base64, in a <script id="__bunfallback">);
 *   - the port is the process's alone: a second instance on the same port fails to
 *     start instead of silently sharing it (SO_REUSEPORT) and splitting connections.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SERVE_MODE } from "../serve-mode.js";
import { BINARY_ENV_KEYS } from "../../scripts/binary-env";

const ENTRY = join(import.meta.dir, "../http.ts");

describe("SERVE_MODE", () => {
  it("is production, and the port is not shared: development and reusePort are false", () => {
    expect(SERVE_MODE).toEqual({ development: false, reusePort: false });
  });

  it("an error escaping fetch → a bare 500: no message, no stack, no Bun error page", async () => {
    // In a child process: the test runner would fail the test on the thrown error itself.
    const secret = "SECRET-DETAIL from the handler";
    const dir = mkdtempSync(join(tmpdir(), "rp-mcp-serve-throw-"));
    const script = join(dir, "throw.ts");
    await Bun.write(
      script,
      `import { SERVE_MODE } from ${JSON.stringify(join(import.meta.dir, "../serve-mode.ts"))};
const server = Bun.serve({ port: 0, ...SERVE_MODE, fetch() { throw new Error(${JSON.stringify(secret)}); } });
const res = await fetch("http://127.0.0.1:" + server.port + "/", { headers: { accept: "text/html" } });
console.log(JSON.stringify({ status: res.status, body: await res.text() }));
server.stop(true);
`,
    );
    try {
      const out = Bun.spawnSync([process.execPath, "run", script], { env: { PATH: process.env.PATH ?? "" } });
      const line = out.stdout.toString().trim().split("\n").pop()!;
      const { status, body } = JSON.parse(line) as { status: number; body: string };
      expect(status).toBe(500);
      expect(body).not.toContain("__bunfallback");
      expect(body).not.toContain(secret);
      expect(body).not.toContain(Buffer.from(secret).toString("base64").slice(0, 16));
      expect(body.length).toBeLessThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every listener in http.ts spreads it: each Bun.serve(…) and the default export", () => {
    const src = readFileSync(ENTRY, "utf8");
    const serves = [...src.matchAll(/Bun\.serve\(\{[^}]*\}\)/g)].map((m) => m[0]);
    expect(serves.length).toBeGreaterThan(0);
    for (const call of serves) expect(call).toContain("...SERVE_MODE");
    const exported = src.slice(src.indexOf("export default {"));
    expect(exported.slice(0, exported.indexOf("};"))).toContain("...SERVE_MODE");
    // Never set any other way in the entry point.
    expect(src).not.toMatch(/development\s*:/);
    expect(src).not.toMatch(/reusePort\s*:/);
  });
});

describe("the spawned entry point (no NODE_ENV)", () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port as number;
    probe.stop(true);
    return port;
  }

  /** Start src/http.ts on `port`; resolves once Bun reports its server, or the process exits. */
  async function start(port: number, env: Record<string, string>) {
    const cwd = mkdtempSync(join(tmpdir(), "rp-mcp-serve-mode-"));
    dirs.push(cwd);
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      ...Object.fromEntries(BINARY_ENV_KEYS.map((k) => [k.key, ""])),
      RPI_MCP_HTTP_PORT: String(port),
      ...env,
    };
    expect("NODE_ENV" in childEnv).toBe(false);
    const state = { log: "", exitCode: null as number | null };
    const child = spawn(process.execPath, ["run", ENTRY], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", (d) => (state.log += d));
    child.stderr?.on("data", (d) => (state.log += d));
    child.on("exit", (code) => (state.exitCode = code ?? -1));
    for (let i = 0; i < 150 && state.exitCode === null && !STARTED.test(state.log); i++) await Bun.sleep(100);
    return state;
  }

  /** Bun's own line once the default export is served (not its source, quoted in an error). */
  const STARTED = /^Started (development )?server: http/m;

  const MODES = [
    ["token mode (one listener, no hostname)", { AUTH_REQUIRED: "true" }],
    // The proxy user (stand-in values) is what makes it env-credential mode; RPI is unset, so it boots degraded.
    ["env-credential mode (127.0.0.1 + [::1])", { AUTH_REQUIRED: "false", RPI_PROXY_ENABLED: "true", RPI_PROXY_USER: "svc", RPI_PROXY_PASS: "stand-in" }],
  ] as const;

  for (const [mode, env] of MODES) {
    it(`${mode}: Bun reports a production server, never a development one`, async () => {
      const first = await start(freePort(), env);
      expect(first.log).toMatch(/^Started server: http/m);
      expect(first.log).not.toMatch(/^Started development server/m);
      if (env.AUTH_REQUIRED === "false") expect(first.log).toMatch(/local only/);
    }, 30_000);

    it(`${mode}: a second instance on the same port fails to start; the first keeps serving`, async () => {
      const port = freePort();
      const first = await start(port, env);
      expect(first.exitCode).toBeNull();
      if (env.AUTH_REQUIRED === "false") expect(first.log).toContain(`and [::1]:${port}`);
      const second = await start(port, env);
      for (let i = 0; i < 100 && second.exitCode === null; i++) await Bun.sleep(100);
      expect(second.exitCode).not.toBe(0);
      expect(second.exitCode).not.toBeNull();
      expect(second.log).toMatch(/in use|EADDRINUSE/);
      expect(second.log).not.toMatch(STARTED);
      // The first still answers, on every address it bound.
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      if (env.AUTH_REQUIRED === "false") expect((await fetch(`http://[::1]:${port}/health`)).status).toBe(200);
      expect(first.exitCode).toBeNull();
    }, 60_000);
  }
});
