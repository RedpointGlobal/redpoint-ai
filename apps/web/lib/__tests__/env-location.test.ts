/**
 * Phase 2 inc 1 — the shared Environment Location credential resolver used by
 * BOTH credentials auth paths (native RPI + SSO password). Locks the SSRF-reject,
 * fail-safe-to-default, and present-but-rejected matrix deterministically.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { resolveEnvLocation } from "../env-location";

const saved = process.env.RPI_URL_ALLOWLIST;
afterEach(() => {
  if (saved === undefined) delete process.env.RPI_URL_ALLOWLIST;
  else process.env.RPI_URL_ALLOWLIST = saved;
});

describe("resolveEnvLocation", () => {
  it("absent / blank → undefined (fall to env default — backward-compat)", () => {
    expect(resolveEnvLocation(undefined)).toBeUndefined();
    expect(resolveEnvLocation(null)).toBeUndefined();
    expect(resolveEnvLocation("")).toBeUndefined();
    expect(resolveEnvLocation("   ")).toBeUndefined();
    expect(resolveEnvLocation(123)).toBeUndefined(); // non-string
  });

  it("configured + allowlisted https → the trimmed URL (target it)", () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    expect(resolveEnvLocation("https://loc-a.example.com")).toBe(
      "https://loc-a.example.com",
    );
    expect(resolveEnvLocation("  https://loc-a.example.com  ")).toBe(
      "https://loc-a.example.com",
    );
  });

  it("present but SSRF-rejected → null (fail the login, never connect)", () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    expect(resolveEnvLocation("https://evil.attacker.com")).toBeNull(); // off-allowlist
    expect(resolveEnvLocation("http://loc-a.example.com")).toBeNull(); // non-https
    expect(resolveEnvLocation("https://notexample.com")).toBeNull(); // look-alike
    expect(resolveEnvLocation("https://example.com.evil.com")).toBeNull();
    expect(resolveEnvLocation("not a url")).toBeNull(); // malformed
  });

  it("feature OFF (empty allowlist) → any present URL is rejected (null), absent still default", () => {
    delete process.env.RPI_URL_ALLOWLIST;
    expect(resolveEnvLocation("https://loc-a.example.com")).toBeNull();
    expect(resolveEnvLocation(undefined)).toBeUndefined();
  });
});
