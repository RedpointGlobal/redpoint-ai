/**
 * Phase 1b — the Environment Location server signal. Enabled ONLY when
 * RPI_URL_ALLOWLIST is configured; never exposes the allowlist contents.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rpiLocationConfig } from "../rpi-location";

const savedAllow = process.env.RPI_URL_ALLOWLIST;
const savedUrl = process.env.RPI_INTEGRATION_API_URL;
afterEach(() => {
  if (savedAllow === undefined) delete process.env.RPI_URL_ALLOWLIST;
  else process.env.RPI_URL_ALLOWLIST = savedAllow;
  if (savedUrl === undefined) delete process.env.RPI_INTEGRATION_API_URL;
  else process.env.RPI_INTEGRATION_API_URL = savedUrl;
});

describe("rpiLocationConfig", () => {
  it("enabled=false when RPI_URL_ALLOWLIST is unset (feature off → hide field)", () => {
    delete process.env.RPI_URL_ALLOWLIST;
    expect(rpiLocationConfig().enabled).toBe(false);
  });

  it("enabled=true when RPI_URL_ALLOWLIST is configured", () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    expect(rpiLocationConfig().enabled).toBe(true);
  });

  it("placeholder = RPI_INTEGRATION_API_URL (default instance), never the allowlist", () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    process.env.RPI_INTEGRATION_API_URL = "https://default.example.test";
    const cfg = rpiLocationConfig();
    expect(cfg.placeholder).toBe("https://default.example.test");
    // The payload must not carry allowlist contents.
    expect(JSON.stringify(cfg)).not.toContain("example.com");
  });

  it("urlAllowed reflects a probed url: allowed → true, off-allowlist → false, none → null", () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    expect(rpiLocationConfig("https://loc-a.example.com").urlAllowed).toBe(true);
    expect(rpiLocationConfig("https://evil.attacker.com").urlAllowed).toBe(false);
    expect(rpiLocationConfig("http://loc-a.example.com").urlAllowed).toBe(false); // non-https
    expect(rpiLocationConfig().urlAllowed).toBeNull();
    expect(rpiLocationConfig("").urlAllowed).toBeNull();
  });

  it("with the feature OFF, a probed url is still not allowed (empty allowlist)", () => {
    delete process.env.RPI_URL_ALLOWLIST;
    expect(rpiLocationConfig("https://loc-a.example.com").urlAllowed).toBe(false);
  });
});
