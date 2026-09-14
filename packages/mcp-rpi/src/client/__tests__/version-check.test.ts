import { describe, it, expect } from "bun:test";
import {
  parseMajorMinor,
  compareVersion,
  BUILT_AGAINST_API_VERSION,
} from "../version-check";

describe("parseMajorMinor", () => {
  it("extracts MAJOR.MINOR from a 4-part RPI version", () => {
    expect(parseMajorMinor("7.7.0.0")).toBe("7.7");
    expect(parseMajorMinor("7.8.1.2")).toBe("7.8");
    expect(parseMajorMinor("10.11.3.0")).toBe("10.11");
  });
  it("accepts already-short forms", () => {
    expect(parseMajorMinor("7.7")).toBe("7.7");
    expect(parseMajorMinor("7.7 (build 123)")).toBe("7.7");
  });
  it("returns null for absent/garbage → 'unknown' upstream (fail-open)", () => {
    expect(parseMajorMinor(null)).toBeNull();
    expect(parseMajorMinor(undefined)).toBeNull();
    expect(parseMajorMinor("")).toBeNull();
    expect(parseMajorMinor("v7")).toBeNull();
    expect(parseMajorMinor("seven-seven")).toBeNull();
    expect(parseMajorMinor("7")).toBeNull(); // needs two numeric components
  });
});

describe("compareVersion (coarse MAJOR.MINOR gate)", () => {
  it("built-against is 7.8", () => {
    expect(BUILT_AGAINST_API_VERSION).toBe("7.8");
  });
  it("match on same MAJOR.MINOR regardless of patch", () => {
    expect(compareVersion("7.8.0.0")).toBe("match");
    expect(compareVersion("7.8.9.5")).toBe("match");
    expect(compareVersion("7.8")).toBe("match");
  });
  it("mismatch on a different MAJOR or MINOR", () => {
    expect(compareVersion("7.7.0.0")).toBe("mismatch"); // the prior built-against
    expect(compareVersion("8.8.0.0")).toBe("mismatch");
    expect(compareVersion("6.8.0.0")).toBe("mismatch");
  });
  it("unknown (fail-open) on absent/unparseable", () => {
    expect(compareVersion(null)).toBe("unknown");
    expect(compareVersion(undefined)).toBe("unknown");
    expect(compareVersion("")).toBe("unknown");
    expect(compareVersion("garbage")).toBe("unknown");
  });
  it("honors an explicit builtAgainst override", () => {
    expect(compareVersion("7.8.0.0", "7.8")).toBe("match");
    expect(compareVersion("7.7.0.0", "7.8")).toBe("mismatch");
  });
});
