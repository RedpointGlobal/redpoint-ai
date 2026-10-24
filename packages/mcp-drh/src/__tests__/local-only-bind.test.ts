/**
 * The bind per mode, on the real entry point (src/http.ts, spawned from a temp cwd
 * with EVERY key of the binary env contract pinned — empty unless the case sets it —
 * because the entry point fills any unset key from the repo-root .env. DRH is left
 * empty, so it boots degraded and makes no network call). Env-credential mode (AUTH_REQUIRED=false +
 * the proxy user) binds 127.0.0.1 only, refuses a page from another site, and
 * rate-limits; token mode keeps every interface.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { networkInterfaces, tmpdir } from "os";
import { join } from "path";
import { MAX_REQUESTS_PER_PEER, MAX_REQUESTS_PER_USER } from "../rate-limit.js";
import { BINARY_ENV_KEYS } from "../../scripts/binary-env";

const ENTRY = join(import.meta.dir, "../http.ts");
let child: ChildProcess | undefined;
let lastEnv: Record<string, string> = {};
let cwd = "";
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

/** A non-loopback IPv4 address of this machine (null when there is none). */
const lanAddress = (): string | null =>
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? null;

async function boot(env: Record<string, string>): Promise<{ port: number; log: () => string }> {
  const port = 39300 + Math.floor(Math.random() * 600);
  cwd = mkdtempSync(join(tmpdir(), "rp-drh-bind-"));
  let log = "";
  lastEnv = {
    PATH: process.env.PATH ?? "",
    HOME: cwd,
    // Every contract key present (empty), so the root .env can fill none of them.
    // (scripts/__tests__/binary-env.test.ts holds the contract to every env var
    // src/ reads, so a new key joins this list or fails that test.)
    ...Object.fromEntries(BINARY_ENV_KEYS.map((k) => [k.key, ""])),
    DRH_MCP_HTTP_PORT: String(port),
    ...env,
  };
  child = spawn(process.execPath, ["run", ENTRY], {
    cwd,
    env: lastEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !/starting on/.test(log); i++) await Bun.sleep(100);
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      await Bun.sleep(100);
    }
  }
  return { port, log: () => log };
}

const reachable = async (url: string, headers: Record<string, string> = {}) => {
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(2000) })).status;
  } catch {
    return "refused";
  }
};

describe("the spawned environment", () => {
  it("pins every binary-contract key, so none can fall through to the repo-root .env", async () => {
    const { log } = await boot({ DRH_PIN_CLIENT_ID: "true" });
    const pinned = Object.keys(lastEnv);
    for (const k of BINARY_ENV_KEYS) expect(pinned).toContain(k.key);
    // Degraded (no DRH backend): no sign-on was attempted at boot, so no root
    // value was used; /health reports degraded.
    expect(log()).toMatch(/DEGRADED MODE/);
  }, 30_000);
});

describe("the bind per mode (src/http.ts)", () => {
  it("env-credential mode: 127.0.0.1 only, named on the startup line; a foreign page and a rebinding Host refused; rate-limited", async () => {
    const { port, log } = await boot({ AUTH_REQUIRED: "false", DRH_PROXY_USER: "probe", DRH_PROXY_PASS: "probe" });
    expect(log()).toMatch(new RegExp(`starting on 127\\.0\\.0\\.1:${port}( and \\[::1\\]:${port})? — local only`));
    expect(await reachable(`http://127.0.0.1:${port}/health`)).toBe(200);
    // The IPv6 loopback too, where it exists (Windows resolves localhost to ::1 first).
    if (log().includes(`[::1]:${port}`)) expect(await reachable(`http://[::1]:${port}/health`)).toBe(200);
    expect(await reachable(`http://localhost:${port}/health`)).toBe(200);
    const lan = lanAddress();
    if (lan) expect(await reachable(`http://${lan}:${port}/health`)).toBe("refused");
    expect(await reachable(`http://127.0.0.1:${port}/health`, { origin: "https://evil.example" })).toBe(403);
    expect(await reachable(`http://127.0.0.1:${port}/mcp`, { origin: "null" })).toBe(403);
    expect(await reachable(`http://127.0.0.1:${port}/health`, { host: `evil.example:${port}` })).toBe(403);
    // The per-peer flood ceiling only (every client here is the loopback peer):
    // there is no per-user cap in env-credential mode (one account, local clients).
    let first429 = 0;
    for (let i = 1; i <= MAX_REQUESTS_PER_PEER + 5 && !first429; i++) if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 429) first429 = i;
    // (The boot poll and the checks above already spent a few of the window's requests.)
    expect(first429).toBeGreaterThan(MAX_REQUESTS_PER_PEER - 10);
    expect(first429).toBeLessThanOrEqual(MAX_REQUESTS_PER_PEER + 1);
    expect(first429).toBeGreaterThan(MAX_REQUESTS_PER_USER + 1);
  }, 30_000);

  it("token mode (AUTH_REQUIRED unset, pinned): every interface, no local-only rule", async () => {
    const { port, log } = await boot({ DRH_PIN_CLIENT_ID: "true" });
    expect(log()).toContain(`starting on port ${port} (all interfaces)`);
    const lan = lanAddress();
    if (lan) expect(await reachable(`http://${lan}:${port}/health`)).toBe(200);
    expect(await reachable(`http://127.0.0.1:${port}/health`, { origin: "https://evil.example" })).toBe(200);
  }, 30_000);

  it("auth off WITHOUT the proxy user is not env-credential mode (no account to act as)", async () => {
    const { port, log } = await boot({ AUTH_REQUIRED: "false" });
    expect(log()).toContain(`starting on port ${port} (all interfaces)`);
  }, 30_000);
});
