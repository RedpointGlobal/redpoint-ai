/**
 * Unit tests for response-filter.ts. Ported from the Java MCPResponseFilter
 * behavior with extra edge cases for JS/TS specifics (undefined, nested).
 */
import { describe, it, expect } from "bun:test";
import {
  filterResponse,
  estimateTokenSavings,
  FIELDS_TO_REMOVE,
  METADATA_FIELDS_TO_KEEP,
} from "../client/response-filter.js";

describe("filterResponse", () => {
  describe("verbose=true", () => {
    it("returns the body reference-equal when verbose", () => {
      const input = { $jsonType: "x", name: "y" };
      expect(filterResponse(input, true)).toBe(input);
    });
  });

  describe("stripped fields", () => {
    it("removes $jsonType", () => {
      expect(filterResponse({ $jsonType: "T", name: "n" }, false)).toEqual({
        name: "n",
      });
    });

    it("removes $jsonTypeID", () => {
      expect(
        filterResponse({ $jsonTypeID: "abc", value: 1 }, false),
      ).toEqual({ value: 1 });
    });

    it("removes data", () => {
      expect(
        filterResponse({ data: { huge: "obj" }, summary: "s" }, false),
      ).toEqual({ summary: "s" });
    });

    it("removes fileInfo", () => {
      expect(
        filterResponse({ fileInfo: { size: 9999 }, name: "x" }, false),
      ).toEqual({ name: "x" });
    });

    it("removes all of them in one pass", () => {
      const input = {
        $jsonType: "T",
        $jsonTypeID: "id",
        data: {},
        fileInfo: {},
        kept: true,
      };
      expect(filterResponse(input, false)).toEqual({ kept: true });
    });
  });

  describe("$metadata handling", () => {
    it("keeps $metadata.validationIssues", () => {
      const input = {
        $metadata: {
          validationIssues: [{ message: "oops" }],
          otherField: "drop me",
        },
        name: "n",
      };
      expect(filterResponse(input, false)).toEqual({
        $metadata: { validationIssues: [{ message: "oops" }] },
        name: "n",
      });
    });

    it("drops $metadata entirely when nothing worth keeping", () => {
      const input = {
        $metadata: { otherField: "drop", another: 5 },
        name: "n",
      };
      expect(filterResponse(input, false)).toEqual({ name: "n" });
    });

    it("drops $metadata when validationIssues is an empty array", () => {
      const input = {
        $metadata: { validationIssues: [] },
        name: "n",
      };
      expect(filterResponse(input, false)).toEqual({ name: "n" });
    });

    it("drops $metadata when validationIssues is null", () => {
      const input = {
        $metadata: { validationIssues: null },
        name: "n",
      };
      expect(filterResponse(input, false)).toEqual({ name: "n" });
    });
  });

  describe("recursion", () => {
    it("recurses into arrays", () => {
      const input = [
        { $jsonType: "A", keep: 1 },
        { $jsonType: "B", keep: 2 },
      ];
      expect(filterResponse(input, false)).toEqual([{ keep: 1 }, { keep: 2 }]);
    });

    it("recurses into nested objects", () => {
      const input = {
        outer: { $jsonType: "O", inner: { $jsonType: "I", leaf: true } },
      };
      expect(filterResponse(input, false)).toEqual({
        outer: { inner: { leaf: true } },
      });
    });

    it("recurses into deeply nested arrays of objects", () => {
      const input = {
        items: [
          { $jsonTypeID: "1", nested: { fileInfo: {}, value: "v" } },
        ],
      };
      expect(filterResponse(input, false)).toEqual({
        items: [{ nested: { value: "v" } }],
      });
    });
  });

  describe("pass-through cases", () => {
    it("returns primitives unchanged", () => {
      expect(filterResponse("x", false)).toBe("x");
      expect(filterResponse(42, false)).toBe(42);
      expect(filterResponse(true, false)).toBe(true);
    });

    it("returns null/undefined unchanged", () => {
      expect(filterResponse(null, false)).toBe(null);
      expect(filterResponse(undefined, false)).toBe(undefined);
    });

    it("returns an empty object unchanged", () => {
      expect(filterResponse({}, false)).toEqual({});
    });

    it("leaves non-stripped keys alone", () => {
      const input = { id: 1, name: "x", tags: ["a", "b"] };
      expect(filterResponse(input, false)).toEqual(input);
    });
  });

  describe("does not mutate input", () => {
    it("keeps the original body intact", () => {
      const input = {
        $jsonType: "T",
        nested: { fileInfo: {}, keep: "me" },
      };
      const snapshot = JSON.stringify(input);
      filterResponse(input, false);
      expect(JSON.stringify(input)).toBe(snapshot);
    });
  });
});

describe("estimateTokenSavings", () => {
  it("returns 0 when inputs are null or undefined", () => {
    expect(estimateTokenSavings(null, { x: 1 })).toBe(0);
    expect(estimateTokenSavings({ x: 1 }, null)).toBe(0);
    expect(estimateTokenSavings(undefined, undefined)).toBe(0);
  });

  it("returns a positive estimate when the filtered value is smaller", () => {
    const original = { $jsonType: "Large".repeat(40), keep: "x" };
    const filtered = { keep: "x" };
    expect(estimateTokenSavings(original, filtered)).toBeGreaterThan(0);
  });

  it("returns 0 when nothing was removed", () => {
    const same = { keep: "x" };
    expect(estimateTokenSavings(same, same)).toBe(0);
  });
});

describe("exported constants", () => {
  it("FIELDS_TO_REMOVE matches the Java filter", () => {
    expect([...FIELDS_TO_REMOVE].sort()).toEqual([
      "$jsonType",
      "$jsonTypeID",
      "data",
      "fileInfo",
    ]);
  });

  it("METADATA_FIELDS_TO_KEEP is just validationIssues", () => {
    expect([...METADATA_FIELDS_TO_KEEP]).toEqual(["validationIssues"]);
  });
});
