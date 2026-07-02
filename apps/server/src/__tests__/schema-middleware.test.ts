/**
 * Schema middleware — unit tests.
 *
 * Verifies that provider-specific JSON Schema field stripping works correctly.
 * MCP tools can include any valid JSON Schema in their inputSchema, but LLM
 * providers reject certain fields. The middleware bridges this gap.
 *
 * Pure functions — no mocks needed.
 */

import { describe, it, expect } from "bun:test";
import { createSchemaMiddleware } from "../config/schema-middleware.js";
import type { JSONSchema7 } from "json-schema";

async function cleanWith(
  provider: string,
  schema: JSONSchema7,
): Promise<JSONSchema7> {
  const middleware = createSchemaMiddleware(provider);
  const params = {
    tools: [
      { type: "function" as const, name: "test", inputSchema: schema },
    ],
  };
  const result = await middleware.transformParams!({ params } as any);
  return (result as any).tools[0].inputSchema;
}

describe("schema-middleware", () => {
  describe("azure-openai", () => {
    it("strips examples, format, contentEncoding, contentMediaType", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          name: {
            type: "string",
            examples: ["foo"],
            format: "email",
            contentEncoding: "base64",
            contentMediaType: "image/png",
          },
        },
      };
      const cleaned = await cleanWith("azure-openai", schema);
      const nameProp = cleaned.properties!.name as JSONSchema7;

      expect(nameProp.type).toBe("string");
      expect(nameProp.examples).toBeUndefined();
      expect(nameProp.format).toBeUndefined();
      expect(nameProp.contentEncoding).toBeUndefined();
      expect(nameProp.contentMediaType).toBeUndefined();
    });

    it("strips empty required array", async () => {
      const schema: JSONSchema7 = { type: "object", required: [] };
      const cleaned = await cleanWith("azure-openai", schema);

      expect(cleaned.required).toBeUndefined();
    });
  });

  describe("anthropic", () => {
    it("strips numeric constraints (min, max, multipleOf)", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          age: {
            type: "number",
            minimum: 0,
            maximum: 150,
            exclusiveMinimum: 0,
            exclusiveMaximum: 200,
            multipleOf: 1,
          },
        },
      };
      const cleaned = await cleanWith("anthropic", schema);
      const ageProp = cleaned.properties!.age as JSONSchema7;

      expect(ageProp.type).toBe("number");
      expect(ageProp.minimum).toBeUndefined();
      expect(ageProp.maximum).toBeUndefined();
      expect(ageProp.exclusiveMinimum).toBeUndefined();
      expect(ageProp.exclusiveMaximum).toBeUndefined();
      expect(ageProp.multipleOf).toBeUndefined();
    });

    it("strips string constraints (minLength, maxLength, pattern)", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          code: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            pattern: "^[A-Z]+$",
          },
        },
      };
      const cleaned = await cleanWith("anthropic", schema);
      const codeProp = cleaned.properties!.code as JSONSchema7;

      expect(codeProp.type).toBe("string");
      expect(codeProp.minLength).toBeUndefined();
      expect(codeProp.maxLength).toBeUndefined();
      expect(codeProp.pattern).toBeUndefined();
    });

    it("strips additionalProperties unless false", async () => {
      const schemaTrue: JSONSchema7 = {
        type: "object",
        additionalProperties: true,
      };
      const schemaFalse: JSONSchema7 = {
        type: "object",
        additionalProperties: false,
      };

      const cleanedTrue = await cleanWith("anthropic", schemaTrue);
      const cleanedFalse = await cleanWith("anthropic", schemaFalse);

      expect(cleanedTrue.additionalProperties).toBeUndefined();
      expect(cleanedFalse.additionalProperties).toBe(false);
    });
  });

  describe("openai", () => {
    it("passes schema through unchanged (empty strip list)", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          name: {
            type: "string",
            examples: ["foo"],
            format: "email",
            minLength: 1,
            maxLength: 100,
          },
        },
        required: ["name"],
      };
      const cleaned = await cleanWith("openai", schema);
      const nameProp = cleaned.properties!.name as JSONSchema7;

      expect(nameProp.examples).toEqual(["foo"]);
      expect(nameProp.format).toBe("email");
      expect(nameProp.minLength).toBe(1);
      expect(nameProp.maxLength).toBe(100);
    });
  });

  it("handles nested properties recursively", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            zip: {
              type: "string",
              format: "postal-code",
              examples: ["90210"],
            },
          },
        },
      },
    };
    const cleaned = await cleanWith("azure-openai", schema);
    const zipProp = (cleaned.properties!.address as JSONSchema7).properties!
      .zip as JSONSchema7;

    expect(zipProp.type).toBe("string");
    expect(zipProp.format).toBeUndefined();
    expect(zipProp.examples).toBeUndefined();
  });
});
