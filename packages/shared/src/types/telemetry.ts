/**
 * Structured telemetry event — verbatim port of the terminal-agent's
 * TelemetryEvent (mirrored from the sibling terminal agent) so a
 * web export and a terminal export are drop-in interchangeable.
 *
 * Direction tags turn a flat log into something readable at a glance:
 *   ToLLM    → agent calling the LLM
 *   FromLLM  → LLM step / token usage report
 *   ToMCP    → agent calling an MCP tool
 *   FromMCP  → tool result coming back
 *   System   → lifecycle, errors, warmup
 */
export interface TelemetryEvent {
  /** ISO 8601 with millisecond precision (HH:mm:ss.SSS in terminal; ISO here for cross-runtime parity). */
  timestamp: string;
  /** Traffic direction — who sent this to whom. */
  direction: "ToLLM" | "FromLLM" | "ToMCP" | "FromMCP" | "System";
  /** Event classification. */
  type:
    | "generation-start"
    | "tool-call"
    | "tool-result"
    | "step-finish"
    | "generation-finish";
  /** Tool name (for tool-call and tool-result events). */
  toolName?: string;
  /** Tool call arguments — the full JSON the LLM sent. */
  args?: unknown;
  /** Tool result — the full response from the MCP server. */
  result?: unknown;
  /** Error message (for failed tool calls or runtime errors). */
  error?: string;
  /** Execution time in milliseconds. */
  durationMs?: number;
  /** Token usage for this step.
   *  - `cached`: tokens served from prompt-cache hit (read). Anthropic
   *    bills these at ~10% of normal; OpenAI/Azure at ~50%. Turn-2 of
   *    a multi-turn chat should show cached:N — that's binary
   *    verification that caching is firing.
   *  - `cacheCreated`: tokens written into the cache on this step
   *    (Anthropic-specific; OpenAI auto-caches without a separate write count).
   */
  tokens?: {
    in?: number;
    out?: number;
    total?: number;
    cached?: number;
    cacheCreated?: number;
  };
  /** Formatted one-line summary for display ("→ list_audiences(...)" etc.). */
  message: string;
  /**
   * Origin of the event — used by the web Traffic panel to separate
   * "glance" (telemetry: tool calls, step boundaries, errors — the
   * meaningful steps) from "forensic" (lifecycle: thread.runStart,
   * composer.send, etc. — visible only in the export).
   *
   * Optional because the terminal agent doesn't emit lifecycle events
   * and exports from there have no reason to set it. When absent, the
   * event is treated as telemetry (the safer default — it's more likely
   * meaningful than ignorable).
   */
  source?: "lifecycle" | "telemetry";
}
