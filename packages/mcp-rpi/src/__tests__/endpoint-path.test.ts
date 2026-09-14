import { describe, it, expect } from "bun:test";
import { normalizeEndpoint } from "../endpoint-path.js";

describe("normalizeEndpoint", () => {
  it("strips a leading /api/v2 so spec paths align with tool literals", () => {
    expect(normalizeEndpoint("/api/v2/client/files/audience")).toBe(
      "/client/files/audience",
    );
  });

  it("is idempotent on already-post-prefix paths", () => {
    expect(normalizeEndpoint("/client/files/audience")).toBe(
      "/client/files/audience",
    );
  });

  it("collapses {param} templates to {} (param-name agnostic)", () => {
    expect(
      normalizeEndpoint("/api/v2/interactions/{interactionId}/activity"),
    ).toBe("/interactions/{}/activity");
    expect(normalizeEndpoint("/interactions/{id}/activity")).toBe(
      "/interactions/{}/activity",
    );
  });

  it("drops query string and trailing slash", () => {
    expect(normalizeEndpoint("/client/files/audience?ID=5")).toBe(
      "/client/files/audience",
    );
    expect(normalizeEndpoint("/client/files/audience/")).toBe(
      "/client/files/audience",
    );
  });

  it("does not strip /api/v2 when it's a mid-path substring", () => {
    // only a leading /api/v2 segment is stripped
    expect(normalizeEndpoint("/client/api/v2thing")).toBe("/client/api/v2thing");
  });
});
