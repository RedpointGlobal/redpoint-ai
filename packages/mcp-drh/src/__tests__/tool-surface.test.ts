/**
 * The exposed tool count is pinned (EXPOSED_TOOL_COUNT): the binary smoke asserts
 * it on the compiled binary, and this test holds the constant to the tools the
 * server actually registers and leaves enabled.
 */
import { describe, it, expect } from "bun:test";
import { createDrhMcpServer } from "../server.js";
import { EXPOSED_TOOL_COUNT } from "../tool-surface.js";

describe("the exposed tool surface", () => {
  it("with a backend, the server lists exactly EXPOSED_TOOL_COUNT tools, with the write tools disabled", () => {
    const { server } = createDrhMcpServer({} as never);
    const tools = Object.entries((server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools);
    const enabled = tools.filter(([, t]) => t.enabled).map(([name]) => name);
    expect(enabled.length).toBe(EXPOSED_TOOL_COUNT);
    expect(enabled).not.toContain("drh_create_database");
    expect(tools.length).toBeGreaterThan(EXPOSED_TOOL_COUNT);
  });

  it("without a backend, none", () => {
    const { server } = createDrhMcpServer();
    expect(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual([]);
  });
});
