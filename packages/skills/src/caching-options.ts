/**
 * Provider-agnostic prompt-caching hints for the Vercel AI SDK.
 *
 * Pass this as `providerOptions: cachingOptions` to every generateText /
 * streamText / Agent settings site. The SDK silently drops keys for
 * providers other than the active one — zero branching needed.
 *
 * Per-provider behavior:
 *   - **Azure OpenAI / OpenAI**: auto-caches prompts >1024 tokens. The
 *     `promptCacheRetention` hint extends the default 5-min cache to 24h
 *     so multi-turn agent conversations hit the cache. ~50% off cached.
 *   - **Anthropic**: caching is opt-in via `cacheControl: { type: 'ephemeral' }`
 *     applied to the prompt. ~90% off cached. Default TTL is 5min;
 *     `ttl: '1h'` extends it.
 *   - **Google / Ollama**: keys absent here → no-op, no error.
 *
 * Verification: TelemetryEvent.tokens.cached / .cacheCreated populate
 * from usage.inputTokenDetails. Turn-2 of any multi-turn chat should
 * show `cached:N` in step-finish messages — that's binary proof
 * caching is firing. No baseline run needed.
 *
 * Ported from the sibling terminal agent for
 * cross-runtime parity. Same shape, same behavior.
 */
export const cachingOptions = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const, ttl: "1h" as const },
  },
  openai: {
    promptCacheRetention: "24h" as const,
  },
};
