/**
 * The exposed tool count is pinned (EXPOSED_TOOL_COUNT): the binary smoke asserts
 * it on the compiled binary, and this test holds the constant to the tools the
 * server actually registers and leaves enabled.
 */
import { describe, it, expect } from "bun:test";
import { createRPIMcpServer } from "../server.js";
import { EXPOSED_TOOL_COUNT } from "../tool-surface.js";

describe("the exposed tool surface", () => {
  it("the server lists exactly EXPOSED_TOOL_COUNT tools, with the write tools disabled", () => {
    const stubAuth = { proxyEnabled: false, getProxyToken: async () => "", validateToken: async () => false, getLoginSettings: async () => [] };
    const { server } = createRPIMcpServer({ integrationApiUrl: "http://localhost:9", defaultClientId: undefined } as never, stubAuth as never, null, null);
    const tools = Object.entries((server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools);
    const enabled = tools.filter(([, t]) => t.enabled).map(([name]) => name);
    expect(enabled.length).toBe(EXPOSED_TOOL_COUNT);
    expect(enabled).not.toContain("create_folder");
    expect(tools.length).toBeGreaterThan(EXPOSED_TOOL_COUNT);
  });
});
