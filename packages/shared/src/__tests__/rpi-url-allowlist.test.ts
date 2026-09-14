/**
 * SSRF guard for the per-request RPI Environment Location URL (Phase 1a).
 * Secure-by-default: the allowlist is EMPTY unless RPI_URL_ALLOWLIST is set, so
 * the per-request-location feature is OFF until a deployer opts in.
 */
import { describe, it, expect } from "bun:test";
import { isAllowedRpiUrl, rpiUrlAllowlist } from "../rpi-url-allowlist.js";

describe("isAllowedRpiUrl — OFF by default (empty allowlist)", () => {
  it("rejects EVERY url when the allowlist is empty (feature off until configured)", () => {
    expect(isAllowedRpiUrl("https://rpi.example.com", [])).toBe(false);
    // Even a would-be-valid host is rejected with no allowlist configured.
    expect(isAllowedRpiUrl("https://sub.example.com", [])).toBe(false);
  });

  it("with the default (unset env) → empty → rejects everything", () => {
    // rpiUrlAllowlist() with no env returns [] → isAllowedRpiUrl rejects all.
    expect(isAllowedRpiUrl("https://rpi.example.com", rpiUrlAllowlist({} as NodeJS.ProcessEnv))).toBe(false);
  });
});

describe("isAllowedRpiUrl — with a configured allowlist", () => {
  const ALLOW = ["example.com"];

  it("allows an https subdomain of an allowlisted domain", () => {
    expect(isAllowedRpiUrl("https://rpi-integration.example.com/", ALLOW)).toBe(true);
    expect(isAllowedRpiUrl("https://example.com", ALLOW)).toBe(true);
  });

  it("rejects non-https (http / other schemes)", () => {
    expect(isAllowedRpiUrl("http://rpi.example.com", ALLOW)).toBe(false);
    expect(isAllowedRpiUrl("ftp://example.com", ALLOW)).toBe(false);
  });

  it("rejects hosts outside the allowlist (SSRF targets)", () => {
    expect(isAllowedRpiUrl("https://evil.attacker.com", ALLOW)).toBe(false);
    expect(isAllowedRpiUrl("https://169.254.169.254/latest/meta-data", ALLOW)).toBe(false);
    expect(isAllowedRpiUrl("https://localhost:3000", ALLOW)).toBe(false);
  });

  it("rejects look-alike hosts that only SUFFIX-match a non-boundary", () => {
    expect(isAllowedRpiUrl("https://notexample.com", ALLOW)).toBe(false);
    expect(isAllowedRpiUrl("https://example.com.evil.com", ALLOW)).toBe(false);
  });

  it("rejects malformed / empty / non-string input", () => {
    expect(isAllowedRpiUrl("not a url", ALLOW)).toBe(false);
    expect(isAllowedRpiUrl("", ALLOW)).toBe(false);
    expect(isAllowedRpiUrl(undefined, ALLOW)).toBe(false);
    expect(isAllowedRpiUrl(null, ALLOW)).toBe(false);
  });
});

describe("rpiUrlAllowlist (env parsing)", () => {
  it("defaults to EMPTY when env unset (feature off)", () => {
    expect(rpiUrlAllowlist({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("parses RPI_URL_ALLOWLIST (comma-separated, trimmed, lowercased)", () => {
    expect(
      rpiUrlAllowlist({
        RPI_URL_ALLOWLIST: " Example.com , Internal-Ops.Example ",
      } as NodeJS.ProcessEnv),
    ).toEqual(["example.com", "internal-ops.example"]);
  });

  it("blank env value → empty (feature off)", () => {
    expect(rpiUrlAllowlist({ RPI_URL_ALLOWLIST: "  " } as NodeJS.ProcessEnv)).toEqual([]);
  });
});
