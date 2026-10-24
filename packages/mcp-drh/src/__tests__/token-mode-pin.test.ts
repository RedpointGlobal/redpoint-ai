/**
 * Token mode requires the tenant pin (http.ts): DRH can check a caller's token only
 * within one tenant, so AUTH_REQUIRED on without DRH_PIN_CLIENT_ID=true is refused
 * at boot — a named error, exit 78 (configuration), nothing served. Env-credential
 * mode and pinned token mode boot. Spawned with every binary-contract key pinned.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BINARY_ENV_KEYS } from "../../scripts/binary-env";

const ENTRY = join(import.meta.dir, "../http.ts");

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** Boot src/http.ts with `env`; returns its exit code (null = still serving after the wait) and log. */
async function boot(env: Record<string, string>): Promise<{ exitCode: number | null; log: string; health: number | "refused" }> {
  const cwd = mkdtempSync(join(tmpdir(), "rp-drh-pin-"));
  const port = freePort();
  const child = Bun.spawn([process.execPath, "run", ENTRY], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      ...Object.fromEntries(BINARY_ENV_KEYS.map((k) => [k.key, ""])),
      DRH_MCP_HTTP_PORT: String(port),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let health: number | "refused" = "refused";
  for (let i = 0; i < 60 && child.exitCode === null; i++) {
    try {
      health = (await fetch(`http://127.0.0.1:${port}/health`)).status;
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const exitCode = child.exitCode;
  child.kill("SIGKILL");
  const log = (await new Response(child.stderr).text()) + (await new Response(child.stdout).text());
  rmSync(cwd, { recursive: true, force: true });
  return { exitCode, log, health };
}

describe("token mode requires the tenant pin", () => {
  for (const [name, env] of [
    ["AUTH_REQUIRED unset (the default)", {}],
    ["AUTH_REQUIRED=true", { AUTH_REQUIRED: "true" }],
    ["AUTH_REQUIRED=true, DRH_PIN_CLIENT_ID=false", { AUTH_REQUIRED: "true", DRH_PIN_CLIENT_ID: "false" }],
  ] as const) {
    it(`${name}, no pin → refused at boot: exit 78, the named error, nothing served`, async () => {
      const r = await boot(env);
      expect(r.exitCode).toBe(78);
      expect(r.health).toBe("refused");
      expect(r.log).toContain("REFUSED — token mode (AUTH_REQUIRED on) requires the tenant pin");
      expect(r.log).toContain("DRH_PIN_CLIENT_ID=true");
    }, 30_000);
  }

  it("token mode with the pin → boots (degraded here: no backend configured)", async () => {
    const r = await boot({ AUTH_REQUIRED: "true", DRH_PIN_CLIENT_ID: "true" });
    expect(r.exitCode).toBeNull();
    expect(r.health).toBe(200);
    expect(r.log).toContain("Auth required: true");
  }, 30_000);

  it("env-credential mode (auth off, the proxy user) → boots, no pin needed", async () => {
    const r = await boot({ AUTH_REQUIRED: "false", DRH_PROXY_USER: "svc", DRH_PROXY_PASS: "stand-in" });
    expect(r.exitCode).toBeNull();
    expect(r.health).toBe(200);
    expect(r.log).toContain("local only");
  }, 30_000);
});
