import { describe, it, expect } from "bun:test";
import { disableUnservedTools } from "../server.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Minimal fake registry mirroring the shape disableUnservedTools reaches into.
type FakeTool = {
  enabled: boolean;
  _meta?: { endpoints?: string[] };
  disable: () => void;
};
function fakeServer(tools: Record<string, FakeTool>): McpServer {
  return { _registeredTools: tools } as unknown as McpServer;
}
function tool(endpoints: string[] | undefined, enabled = true): FakeTool {
  return {
    enabled,
    _meta: endpoints ? { endpoints } : undefined,
    disable() {
      this.enabled = false;
    },
  };
}

describe("disableUnservedTools (runtime endpoint mask)", () => {
  it("disables a tool whose endpoint the instance does not serve", () => {
    const gone = tool(["/client/files/audience"]);
    const kept = tool(["/interactions"]);
    const server = fakeServer({ get_audience: gone, list_interactions: kept });
    const masked = disableUnservedTools(server, new Set(["/interactions"]));
    expect(masked).toBe(1);
    expect(gone.enabled).toBe(false);
    expect(kept.enabled).toBe(true);
  });

  it("is a cheap no-op when the instance serves everything (empty diff)", () => {
    const a = tool(["/client/files/audience"]);
    const b = tool(["/interactions"]);
    const server = fakeServer({ a, b });
    const masked = disableUnservedTools(
      server,
      new Set(["/client/files/audience", "/interactions", "/extra"]),
    );
    expect(masked).toBe(0);
    expect(a.enabled).toBe(true);
    expect(b.enabled).toBe(true);
  });

  it("fails open when the spec is unreachable (null → no mask)", () => {
    const a = tool(["/client/files/audience"]);
    const server = fakeServer({ a });
    expect(disableUnservedTools(server, null)).toBe(0);
    expect(a.enabled).toBe(true);
  });

  it("keeps a tool that declares no endpoints (can't diff)", () => {
    const undeclared = tool(undefined);
    const server = fakeServer({ undeclared });
    expect(disableUnservedTools(server, new Set(["/interactions"]))).toBe(0);
    expect(undeclared.enabled).toBe(true);
  });

  it("skips already-disabled tools (e.g. the write-gate ran first)", () => {
    const alreadyOff = tool(["/client/files/audience"], false);
    const server = fakeServer({ alreadyOff });
    const masked = disableUnservedTools(server, new Set(["/interactions"]));
    // absent endpoint, but it was already disabled → not counted again
    expect(masked).toBe(0);
    expect(alreadyOff.enabled).toBe(false);
  });

  it("normalizes both sides (a stamped /api/v2 + param path matches the spec)", () => {
    const t = tool(["/api/v2/interactions/{id}/activity"]);
    const server = fakeServer({ t });
    // spec-side path normalizes to /interactions/{}/activity; both collapse equal
    const masked = disableUnservedTools(
      server,
      new Set(["/interactions/{}/activity"]),
    );
    expect(masked).toBe(0);
    expect(t.enabled).toBe(true);
  });
});
