/**
 * Phase 1a increment 5 — the FORWARD link (apps/server → mcp-rpi).
 *
 * The per-user ephemeral MCP transport must carry the per-request RPI location
 * as `X-RPI-URL` alongside the Bearer, so mcp-rpi targets the rep's instance.
 * Backward-compat: no per-request location → NO X-RPI-URL header (mcp-rpi uses
 * its default), so the a2a/agui/non-interactive paths (which forward no URL) are
 * unchanged.
 */
import { describe, it, expect } from "bun:test";
import { ephemeralAuthHeaders } from "../mcp/forward-headers.js";

describe("ephemeralAuthHeaders — forward the per-request location", () => {
  it("bakes X-RPI-URL alongside the Bearer when a location is set", () => {
    const h = ephemeralAuthHeaders("tok", "https://loc-a.example.com");
    expect(h.Authorization).toBe("Bearer tok");
    expect(h["X-RPI-URL"]).toBe("https://loc-a.example.com");
  });

  it("backward-compat: NO location → no X-RPI-URL header (default instance)", () => {
    const h = ephemeralAuthHeaders("tok");
    expect(h.Authorization).toBe("Bearer tok");
    expect("X-RPI-URL" in h).toBe(false);
  });

  it("empty-string location is treated as no location (no header)", () => {
    const h = ephemeralAuthHeaders("tok", "");
    expect("X-RPI-URL" in h).toBe(false);
  });
});
