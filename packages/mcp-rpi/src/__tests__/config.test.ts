import { describe, it, expect } from "bun:test";
import { resolveProxyEnabled } from "../config.js";

describe("resolveProxyEnabled", () => {
  it("returns false when no creds and no flag", () => {
    expect(resolveProxyEnabled({})).toBe(false);
  });

  it("returns true when creds are present and no flag", () => {
    expect(
      resolveProxyEnabled({ RPI_PROXY_USER: "u", RPI_PROXY_PASS: "p" }),
    ).toBe(true);
  });

  it("returns false when flag=false even with creds", () => {
    expect(
      resolveProxyEnabled({
        RPI_PROXY_USER: "u",
        RPI_PROXY_PASS: "p",
        RPI_PROXY_ENABLED: "false",
      }),
    ).toBe(false);
  });

  it("returns true when flag=true with creds", () => {
    expect(
      resolveProxyEnabled({
        RPI_PROXY_USER: "u",
        RPI_PROXY_PASS: "p",
        RPI_PROXY_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("throws when flag=true but creds are missing", () => {
    expect(() =>
      resolveProxyEnabled({ RPI_PROXY_ENABLED: "true" }),
    ).toThrow("RPI_PROXY_ENABLED=true but");
  });

  it("returns false when only username is set", () => {
    expect(resolveProxyEnabled({ RPI_PROXY_USER: "u" })).toBe(false);
  });
});