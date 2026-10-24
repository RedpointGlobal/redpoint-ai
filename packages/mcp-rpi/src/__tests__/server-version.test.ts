/**
 * The RPI MCP server reports its OWN version — version.json, the
 * one source the binary zips, the MCP serverInfo and /health all take it from.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MCP_RPI_VERSION } from "../version.js";
import { createRPIMcpServer } from "../server.js";

const fileVersion = (JSON.parse(readFileSync(join(import.meta.dir, "../../version.json"), "utf8")) as { version: string }).version;

describe("the server's own version", () => {
  it("MCP_RPI_VERSION is version.json (MAJOR.MINOR)", () => {
    expect(MCP_RPI_VERSION).toBe(fileVersion);
    expect(MCP_RPI_VERSION).toMatch(/^\d+\.\d+$/);
  });
  it("the MCP serverInfo reports it", () => {
    const stubAuth = { proxyEnabled: false, getProxyToken: async () => "", validateToken: async () => false, getLoginSettings: async () => [] };
    const { server } = createRPIMcpServer({ integrationApiUrl: "http://localhost:9", defaultClientId: undefined } as never, stubAuth as never, null, null);
    const info = (server as unknown as { server: { _serverInfo: { name: string; version: string } } }).server._serverInfo;
    expect(info).toEqual({ name: "rpi-mcp-server", version: fileVersion });
  });
});
