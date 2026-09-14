import { describe, it, expect } from "bun:test";
import { sanitizeGeneratedTypes } from "./sanitize-generated.js";

describe("sanitizeGeneratedTypes", () => {
  it("rewrites @redpointglobal.com example addresses to @example.com", () => {
    const src =
      '* "value": "apiuser@redpointglobal.com",\n* "defaultValue": "no-reply@redpointglobal.com"';
    const out = sanitizeGeneratedTypes(src);
    expect(out).not.toContain("@redpointglobal.com");
    expect(out).toContain("apiuser@example.com");
    expect(out).toContain("no-reply@example.com");
  });

  it("rewrites the @redpoint.net domain too", () => {
    expect(sanitizeGeneratedTypes("svc@redpoint.net")).toBe("svc@example.com");
  });

  it("leaves other domains and type content untouched", () => {
    const src = "foo@gmail.com bar@company.com type Foo = { id: string };";
    expect(sanitizeGeneratedTypes(src)).toBe(src);
  });

  it("pins the random dummy password example to a fixed placeholder", () => {
    const a = sanitizeGeneratedTypes('"password": "#Aa$47cb2fc051344dd1b88941dbf540278e987"');
    const b = sanitizeGeneratedTypes('"password": "#Aa$377f525f1bd14c48812233b1ac34a26b987"');
    expect(a).toBe('"password": "#Aa$EXAMPLE"');
    // Two different random inputs collapse to the SAME output → deterministic regen.
    expect(a).toBe(b);
  });

  it("leaves static password examples (e.g. newPassword) untouched", () => {
    expect(sanitizeGeneratedTypes('"password": "newPassword"')).toBe(
      '"password": "newPassword"',
    );
  });

  it("is idempotent", () => {
    const once = sanitizeGeneratedTypes(
      "a@redpointglobal.com b@redpoint.net #Aa$deadbeef",
    );
    expect(sanitizeGeneratedTypes(once)).toBe(once);
    expect(once).toBe("a@example.com b@example.com #Aa$EXAMPLE");
  });
});
