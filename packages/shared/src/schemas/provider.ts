import { z } from "zod";

export const LLMProviderSchema = z.object({
  id: z.string(),
  type: z.enum([
    "openai",
    "anthropic",
    "google",
    "ollama",
    "azure-openai",
  ]),
  name: z.string(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()),
  isConfigured: z.boolean(),
});

export type LLMProvider = z.infer<typeof LLMProviderSchema>;
