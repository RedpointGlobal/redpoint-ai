/**
 * Phase 1a increment 6 — SSRF guard at the apps/web login entry (entry #3 of 3).
 * Local mirror of the shared validator; empty allowlist by default (feature off).
 */
import { describe, it, expect } from "bun:test";
import { isAllowedRpiUrl, rpiUrlAllowlist } from "../rpi-url-allowlist";

describe("isAllowedRpiUrl (apps/web login SSRF)", () => {
  it("rejects EVERY url with an empty allowlist (feature off by default)", () => {
    expect(isAllowedRpiUrl("https://rpi.example.com", [])).toBe(false);
  });

  it("with a configured allowlist: allows subdomains, rejects the rest", () => {
    const A = ["example.com"];
    expect(isAllowedRpiUrl("https://rpi-integration.example.com", A)).toBe(true);
    expect(isAllowedRpiUrl("https://example.com", A)).toBe(true);
    expect(isAllowedRpiUrl("http://rpi.example.com", A)).toBe(false); // non-https
    expect(isAllowedRpiUrl("https://evil.attacker.com", A)).toBe(false);
    expect(isAllowedRpiUrl("https://notexample.com", A)).toBe(false); // look-alike
    expect(isAllowedRpiUrl("https://example.com.evil.com", A)).toBe(false);
    expect(isAllowedRpiUrl("https://169.254.169.254/latest", A)).toBe(false);
  });

  it("rpiUrlAllowlist: empty by default, parses RPI_URL_ALLOWLIST when set", () => {
    const saved = process.env.RPI_URL_ALLOWLIST;
    try {
      delete process.env.RPI_URL_ALLOWLIST;
      expect(rpiUrlAllowlist()).toEqual([]);
      process.env.RPI_URL_ALLOWLIST = " Example.com , B.test ";
      expect(rpiUrlAllowlist()).toEqual(["example.com", "b.test"]);
    } finally {
      if (saved === undefined) delete process.env.RPI_URL_ALLOWLIST;
      else process.env.RPI_URL_ALLOWLIST = saved;
    }
  });
});
