/**
 * Unit tests for the shared response-shape helpers.
 */
import { describe, it, expect } from "bun:test";
import {
  toCard,
  mapResultsToCards,
  stripNestedFields,
} from "../tools/response-shapes.js";

describe("toCard", () => {
  it("returns the standard card fields", () => {
    const item = {
      id: "a",
      name: "Foo",
      description: "hi",
      extra: "ignored",
    };
    expect(toCard(item)).toEqual({ id: "a", name: "Foo", description: "hi" });
  });

  it("includes requested extras", () => {
    const item = {
      id: "a",
      name: "Foo",
      description: "hi",
      folderFullPath: "/root/marketing",
      subTypeName: "Standard",
      noise: "x",
    };
    expect(toCard(item, ["folderFullPath", "subTypeName"])).toEqual({
      id: "a",
      name: "Foo",
      description: "hi",
      folderFullPath: "/root/marketing",
      subTypeName: "Standard",
    });
  });

  it("leaves missing fields as undefined (serializes to nothing in JSON)", () => {
    const item = { id: "a" };
    const card = toCard(item, ["folderFullPath"]);
    expect(card.id).toBe("a");
    expect(card.name).toBeUndefined();
    expect(card.description).toBeUndefined();
    expect(card.folderFullPath).toBeUndefined();
    expect(JSON.stringify(card)).toBe('{"id":"a"}');
  });
});

describe("mapResultsToCards", () => {
  it("maps the nested array to cards, preserves the envelope", () => {
    const body = {
      pageNumber: 1,
      pageSize: 20,
      totalCount: 2,
      results: [
        { id: "1", name: "A", description: "d1", noise: "x" },
        { id: "2", name: "B", description: "d2", noise: "y" },
      ],
    };
    const out = mapResultsToCards(body, "results") as {
      pageNumber: number;
      results: Array<Record<string, unknown>>;
    };
    expect(out.pageNumber).toBe(1);
    expect(out.results).toEqual([
      { id: "1", name: "A", description: "d1" },
      { id: "2", name: "B", description: "d2" },
    ]);
  });

  it("includes extras on every item", () => {
    const body = {
      results: [
        { id: "1", name: "A", folderFullPath: "/x", noise: "z" },
      ],
    };
    const out = mapResultsToCards(body, "results", ["folderFullPath"]) as {
      results: Array<Record<string, unknown>>;
    };
    expect(out.results[0].folderFullPath).toBe("/x");
    expect(out.results[0].noise).toBeUndefined();
  });

  it("returns body unchanged if the envelope key is missing or not an array", () => {
    const bodyNoKey = { foo: "bar" };
    expect(mapResultsToCards(bodyNoKey, "results")).toBe(bodyNoKey);

    const bodyWrongShape = { results: "not an array" };
    expect(mapResultsToCards(bodyWrongShape, "results")).toBe(bodyWrongShape);
  });

  it("returns primitives / null unchanged", () => {
    expect(mapResultsToCards(null, "results")).toBe(null);
    expect(mapResultsToCards(42, "results")).toBe(42);
  });

  it("does not mutate the input", () => {
    const body = {
      results: [{ id: "1", name: "A", extra: "keepMe" }],
    };
    const snapshot = JSON.stringify(body);
    mapResultsToCards(body, "results");
    expect(JSON.stringify(body)).toBe(snapshot);
  });
});

describe("stripNestedFields", () => {
  it("removes top-level fields", () => {
    const body = { id: "x", name: "y", trainingSets: [1, 2], description: "z" };
    expect(stripNestedFields(body, ["trainingSets"])).toEqual({
      id: "x",
      name: "y",
      description: "z",
    });
  });

  it("removes one-level-nested fields via dotted path", () => {
    const body = {
      id: "x",
      metadata: { items: [1, 2, 3], count: 3 },
    };
    expect(stripNestedFields(body, ["metadata.items"])).toEqual({
      id: "x",
      metadata: { count: 3 },
    });
  });

  it("handles multiple paths in one call", () => {
    const body = {
      id: "x",
      trainingSets: [1],
      offerHistoryAttributes: [{ a: 1 }],
      metadata: { items: [1, 2], keep: true },
    };
    expect(
      stripNestedFields(body, [
        "trainingSets",
        "offerHistoryAttributes",
        "metadata.items",
      ]),
    ).toEqual({
      id: "x",
      metadata: { keep: true },
    });
  });

  it("is a no-op when the targeted field is missing", () => {
    const body = { id: "x" };
    expect(stripNestedFields(body, ["trainingSets", "metadata.items"])).toEqual({
      id: "x",
    });
  });

  it("leaves the container alone when nested path's container isn't an object", () => {
    const body = { id: "x", metadata: "not-an-object" };
    expect(stripNestedFields(body, ["metadata.items"])).toEqual({
      id: "x",
      metadata: "not-an-object",
    });
  });

  it("does not mutate the input", () => {
    const body = {
      id: "x",
      metadata: { items: [1, 2] },
      trainingSets: [9],
    };
    const snapshot = JSON.stringify(body);
    stripNestedFields(body, ["trainingSets", "metadata.items"]);
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it("pass-through for non-objects", () => {
    expect(stripNestedFields(null, ["foo"])).toBe(null);
    expect(stripNestedFields("x" as unknown as Record<string, unknown>, ["foo"])).toBe("x");
  });
});
