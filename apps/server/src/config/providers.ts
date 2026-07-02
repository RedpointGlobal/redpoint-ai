import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createAzure } from "@ai-sdk/azure";
import { ollama } from "ollama-ai-provider-v2";
import type { LanguageModel } from "ai";
import { withSchemaMiddleware } from "./schema-middleware.js";
import { createRetryAfterFetch } from "./retry-fetch.js";

interface ProviderConfig {
  type: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  azureDeployment?: string;
}

/**
 * Resolve ${ENV_VAR} references in a string value.
 */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) {
    return process.env[match[1]] ?? value;
  }
  return value;
}

/**
 * Create an AI SDK model instance from a provider config.
 * Supports: openai, anthropic, google, azure-openai, ollama.
 */
export function createModelFromConfig(config: ProviderConfig): LanguageModel {
  const apiKey = resolveEnvVar(config.apiKey);
  const baseUrl = resolveEnvVar(config.baseUrl);

  let model: LanguageModel;

  switch (config.type) {
    case "openai":
      // If the workspace config provides an explicit apiKey, build a dedicated
      // provider via createOpenAI. Otherwise, fall back to the default openai()
      // singleton, which reads OPENAI_API_KEY from process.env. An empty-string
      // apiKey is treated as "not set" and falls through to env-based auth.
      model = apiKey ? createOpenAI({ apiKey })(config.model) : openai(config.model);
      break;

    case "anthropic":
      model = anthropic(config.model);
      break;

    case "google":
      model = google(config.model);
      break;

    case "azure-openai": {
      const azureProvider = createAzure({
        resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
        apiKey: apiKey || process.env.AZURE_OPENAI_API_KEY,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-01-preview",
        useDeploymentBasedUrls: true,
        // Honor the deployment's real `retry-after` on 429 (the SDK's built-in
        // retry follows the misleading `retry-after-ms: 0` and gives up fast).
        fetch: createRetryAfterFetch(),
      });
      model = azureProvider.chat(config.azureDeployment || config.model);
      break;
    }

    case "ollama":
      model = ollama(config.model);
      break;

    default:
      throw new Error(
        `Unsupported provider: ${config.type}. Supported: openai, anthropic, google, azure-openai, ollama`,
      );
  }

  return withSchemaMiddleware(model, config.type) as LanguageModel;
}

export interface ProviderStatus {
  type: string;
  name: string;
  configured: boolean;
  /** First env var that's missing when configured=false. Lets the UI show a
   *  precise diagnostic ("ANTHROPIC_API_KEY not set") instead of a generic flag. */
  missingEnvVar?: string;
}

/**
 * List available providers with their connection status.
 */
export function listProviders(): ProviderStatus[] {
  const openaiOk = !!process.env.OPENAI_API_KEY;
  const anthropicOk = !!process.env.ANTHROPIC_API_KEY;
  const googleOk = !!(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY
  );
  const azureKey = !!process.env.AZURE_OPENAI_API_KEY;
  const azureResource = !!process.env.AZURE_OPENAI_RESOURCE_NAME;

  return [
    {
      type: "openai",
      name: "OpenAI",
      configured: openaiOk,
      ...(openaiOk ? {} : { missingEnvVar: "OPENAI_API_KEY" }),
    },
    {
      type: "anthropic",
      name: "Anthropic",
      configured: anthropicOk,
      ...(anthropicOk ? {} : { missingEnvVar: "ANTHROPIC_API_KEY" }),
    },
    {
      type: "google",
      name: "Google AI",
      configured: googleOk,
      ...(googleOk ? {} : { missingEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY" }),
    },
    {
      type: "azure-openai",
      name: "Azure OpenAI",
      configured: azureKey && azureResource,
      ...(azureKey && azureResource
        ? {}
        : {
            missingEnvVar: !azureKey
              ? "AZURE_OPENAI_API_KEY"
              : "AZURE_OPENAI_RESOURCE_NAME",
          }),
    },
    // Ollama (local) intentionally omitted from listProviders() until it's an
    // actually wired path. Re-add when a workspace can be configured to use it
    // and we can honestly probe the daemon for "configured" status. Keeping
    // the createModelFromConfig case in place so an explicit workspace.config
    // pointing at ollama still works for anyone who wants to wire it manually.
  ];
}
