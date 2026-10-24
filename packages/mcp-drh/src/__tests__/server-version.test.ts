/**
 * The DRH MCP server reports its OWN version — version.json, the
 * one source the binary zips, the image, the MCP serverInfo and /health all take it
 * from.
 */
import { describe, it, expect } from "bun:test";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { MCP_DRH_VERSION } from "../version.js";
import { createDrhMcpServer } from "../server.js";
import { BINARY_ENV_KEYS } from "../../scripts/binary-env";

const fileVersion = (JSON.parse(readFileSync(join(import.meta.dir, "../../version.json"), "utf8")) as { version: string }).version;

describe("the server's own version", () => {
  it("MCP_DRH_VERSION is version.json (MAJOR.MINOR)", () => {
    expect(MCP_DRH_VERSION).toBe(fileVersion);
    expect(MCP_DRH_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it("the MCP serverInfo reports it, with and without a backend", () => {
    for (const client of [undefined, {} as never]) {
      const { server } = createDrhMcpServer(client);
      const info = (server as unknown as { server: { _serverInfo: { name: string; version: string } } }).server._serverInfo;
      expect(info).toEqual({ name: "drh-mcp-server", version: fileVersion });
    }
  });

  it("/health reports it as serverVersion", async () => {
    const port = 39400 + Math.floor(Math.random() * 90);
    // Every key the server reads is pinned: http.ts fills an UNSET key from the root
    // .env, and this test must reach no DRH instance and use no credential.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    for (const k of BINARY_ENV_KEYS) env[k.key] = "";
    Object.assign(env, { DRH_MCP_HTTP_PORT: String(port), AUTH_REQUIRED: "false", DRH_PROXY_ENABLED: "false" });
    const child = spawn("bun", ["run", join(import.meta.dir, "../http.ts")], { env, stdio: "ignore" });
    try {
      let health: { server?: string; serverVersion?: string } | undefined;
      for (let i = 0; i < 40 && !health; i++) {
        try {
          health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as typeof health;
        } catch {
          await Bun.sleep(250);
        }
      }
      expect(health?.server).toBe("drh-mcp-server");
      expect(health?.serverVersion).toBe(fileVersion);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
