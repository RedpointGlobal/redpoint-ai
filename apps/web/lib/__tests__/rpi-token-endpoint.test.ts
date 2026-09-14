/**
 * Phase 1a increment 6 — the login token-grant targets the ENTERED Environment
 * Location, else the env default.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rpiTokenEndpoint } from "../rpi-token-endpoint";

const orig = process.env.RPI_INTEGRATION_API_URL;
afterEach(() => {
  if (orig === undefined) delete process.env.RPI_INTEGRATION_API_URL;
  else process.env.RPI_INTEGRATION_API_URL = orig;
});

describe("rpiTokenEndpoint", () => {
  it("targets the entered Environment Location when given", () => {
    expect(rpiTokenEndpoint("https://loc-a.example.com")).toBe(
      "https://loc-a.example.com/connect/token",
    );
  });

  it("strips a trailing /api/v2 (and slash) from the entered url", () => {
    expect(rpiTokenEndpoint("https://loc-a.example.com/api/v2/")).toBe(
      "https://loc-a.example.com/connect/token",
    );
  });

  it("falls back to RPI_INTEGRATION_API_URL when no location entered", () => {
    process.env.RPI_INTEGRATION_API_URL = "https://default.example.test";
    expect(rpiTokenEndpoint()).toBe("https://default.example.test/connect/token");
    expect(rpiTokenEndpoint("")).toBe("https://default.example.test/connect/token");
  });

  it("returns null when neither the location nor the env is configured", () => {
    delete process.env.RPI_INTEGRATION_API_URL;
    expect(rpiTokenEndpoint()).toBeNull();
  });
});
