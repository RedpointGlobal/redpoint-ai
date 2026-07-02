import { ToolLoopAgent, stepCountIs, type Tool } from "ai";
import { cachingOptions, pruneMessageHistory } from "@redpoint-ai/skills";
import { createModelFromConfig } from "../config/providers.js";

export function createWorkspaceAgent(config: {
  systemPrompt: string;
  model: string;
  providerType: string;
  maxSteps?: number;
  tools?: Record<string, Tool>;
  apiKey?: string;
  baseUrl?: string;
  azureDeployment?: string;
}) {
  const model = createModelFromConfig({
    type: config.providerType,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    azureDeployment: config.azureDeployment,
  });

  return new ToolLoopAgent({
    model,
    // AI SDK v6's ToolLoopAgent uses `instructions`, not `system`. Passing
    // `system` is silently ignored (no type error in current configs because
    // CallSettings on the agent permits extra keys), which means the entire
    // RPI system prompt was being dropped — agent answered as a generic LLM
    // ("RPI can stand for Rensselaer Polytechnic Institute…") despite the
    // workspace config setting the prompt correctly. Renaming this one field
    // restores the intended behavior.
    instructions: config.systemPrompt,
    // Deterministic routing. Default Azure temperature (~1.0) makes operation/skill
    // selection stochastic — the same prompt can route to operation:"list" one run
    // and "count" the next, and the accuracy eval wobbles run-to-run. temperature 0
    // pins the router to the guideline-prescribed choice for reproducible accuracy.
    temperature: 0,
    stopWhen: stepCountIs(config.maxSteps ?? 20),
    // Bound the completion so Azure's TPM admission estimate
    // (prompt + maxOutputTokens) stays small. Unbounded, Azure assumes the
    // model max (~16K), inflating a ~4.5K routing call's estimate to ~21K >
    // the 10K window → a 429 + retry-after wait on EVERY call (the trivial
    // "list clients" took 64s of pure waiting before any work). The parent
    // only emits ~200 output tokens, so 2000 is ample with zero truncation
    // risk and lets the common case fit without a 429.
    maxOutputTokens: 2000,
    tools: config.tools ?? {},
    // Provider-agnostic prompt caching. Vercel SDK silently drops keys for
    // providers other than the active one. Anthropic ~90% off, OpenAI ~50%
    // off cached prefixes. See packages/skills/src/caching-options.ts.
    providerOptions: cachingOptions,
    // Fail fast on serverless LLM cold-start timeouts. The SDK default of 2
    // retries compounds a 4-minute undici timeout into 12+ minutes. A single
    // failed call surfaces immediately; the user can retry.
    maxRetries: 0,
    // Chat session has no native message-array history management; without
    // this hook a long session accumulates verbatim and overflows gpt-4o's
    // 128K cliff (real recipient incident 2026-05-20 at 427K message
    // tokens). `pruneMessageHistory` truncates oldest tool-result
    // content first, then drops oldest prunable turns. Active turn + system
    // are never prunable; an unfittable budget throws MessageBudgetExceeded
    // (fail loud, never silently wrong). Returns the SAME array reference
    // on no-op so `prepareStep` can short-circuit with `{}`.
    prepareStep: ({ messages }) => {
      const pruned = pruneMessageHistory(messages);
      return pruned === messages ? {} : { messages: pruned };
    },
  });
}
