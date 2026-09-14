/**
 * Phase 1a increment 6 — apps/web forwards the per-request Environment Location
 * as X-RPI-URL alongside X-RPI-Token (the two ride together). apps/server
 * re-validates the URL (SSRF), so forwarding it as-is from the session is safe.
 */
import { describe, it, expect } from "bun:test";
import { pickHeaders } from "../server-forward";

describe("pickHeaders — forward the Environment Location", () => {
  it("X-RPI-Token session with a location → forwards X-RPI-Token + X-RPI-URL", () => {
    const h = pickHeaders({
      rpiAccessToken: "tok",
      rpiUrl: "https://loc-a.example.com",
    });
    expect(h["X-RPI-Token"]).toBe("tok");
    expect(h["X-RPI-URL"]).toBe("https://loc-a.example.com");
  });

  it("backward-compat: X-RPI-Token session with NO location → no X-RPI-URL", () => {
    const h = pickHeaders({ rpiAccessToken: "tok" });
    expect(h["X-RPI-Token"]).toBe("tok");
    expect("X-RPI-URL" in h).toBe(false);
  });

  it("apiKey session → Authorization only, never X-RPI-URL", () => {
    const h = pickHeaders({ apiKey: "rpai_x", rpiUrl: "https://loc-a.example.com" });
    expect(h.Authorization).toBe("Bearer rpai_x");
    expect("X-RPI-URL" in h).toBe(false);
  });

  it("no session → empty headers", () => {
    expect(pickHeaders(null)).toEqual({});
  });
});
