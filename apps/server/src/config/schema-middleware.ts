/**
 * Provider-aware tool schema middleware using the AI SDK's wrapLanguageModel.
 *
 * LLM providers reject different JSON Schema fields in tool inputSchema.
 * The MCP spec allows full JSON Schema, but providers are pickier.
 * This middleware strips fields that the active provider rejects,
 * bridging the gap for LLM agnosticism.
 *
 * To add a new provider: add an entry to PROVIDER_STRIP_FIELDS with the
 * list of JSON Schema property names that provider rejects.
 */

import { wrapLanguageModel } from "ai";
import type { LanguageModelMiddleware } from "ai";
import type { JSONSchema7 } from "json-schema";

const PROVIDER_STRIP_FIELDS: Record<string, Set<string>> = {
  "azure-openai": new Set([
    "examples",
    "format",
    "contentEncoding",
    "contentMediaType",
  ]),

  anthropic: new Set([
    "contentEncoding",
    "contentMediaType",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
  ]),

  openai: new Set([]),
  google: new Set([]),
  ollama: new Set([]),
};

const STRIP_NULL_REQUIRED = new Set(["azure-openai", "openai"]);
const STRIP_EMPTY_REQUIRED = new Set(["azure-openai"]);
const STRICT_ADDITIONAL_PROPERTIES = new Set(["anthropic"]);

function cleanSchema(
  schema: JSONSchema7,
  stripFields: Set<string>,
  provider: string,
): JSONSchema7 {
  if (typeof schema !== "object" || schema === null) return schema;

  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (stripFields.has(key)) continue;

    if (key === "required") {
      if (value === null && STRIP_NULL_REQUIRED.has(provider)) continue;
      if (
        Array.isArray(value) &&
        value.length === 0 &&
        STRIP_EMPTY_REQUIRED.has(provider)
      )
        continue;
    }

    if (
      key === "additionalProperties" &&
      STRICT_ADDITIONAL_PROPERTIES.has(provider)
    ) {
      if (value !== false) continue;
    }

    if (key === "properties" && typeof value === "object" && value !== null) {
      const cleanedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        cleanedProps[propName] = cleanSchema(
          propSchema as JSONSchema7,
          stripFields,
          provider,
        );
      }
      cleaned[key] = cleanedProps;
    } else if (key === "items" && typeof value === "object" && value !== null) {
      cleaned[key] = cleanSchema(value as JSONSchema7, stripFields, provider);
    } else if (
      (key === "anyOf" || key === "oneOf" || key === "allOf") &&
      Array.isArray(value)
    ) {
      cleaned[key] = value.map((v) =>
        cleanSchema(v as JSONSchema7, stripFields, provider),
      );
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned as JSONSchema7;
}

export function createSchemaMiddleware(
  provider: string,
): LanguageModelMiddleware {
  const stripFields = PROVIDER_STRIP_FIELDS[provider] ?? new Set();

  return {
    specificationVersion: "v3",

    transformParams: async ({ params }) => {
      if (!params.tools) return params;

      return {
        ...params,
        tools: params.tools.map((tool) => {
          if (tool.type !== "function") return tool;
          return {
            ...tool,
            inputSchema: cleanSchema(tool.inputSchema, stripFields, provider),
          };
        }),
      };
    },
  };
}

/**
 * Wraps a model with provider-aware schema cleaning middleware.
 */
export function withSchemaMiddleware(
  model: Parameters<typeof wrapLanguageModel>[0]["model"],
  provider: string,
) {
  return wrapLanguageModel({
    model,
    middleware: createSchemaMiddleware(provider),
  });
}
