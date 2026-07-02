/**
 * Hallucination detector for LLM responses.
 *
 * Catches cases where the LLM claims an action was completed ("stored successfully",
 * "created the rule") without actually calling a tool. Observed in v3 CLI testing
 * at ~29% rate on vague user confirmations ("yes", "1", "sure"). The LLM infers
 * from conversation context that an action was performed and reports success
 * without any backing tool call.
 *
 * Ported from RP-Vercel-Agent v3 (src/components/App.tsx:122-128, 146-150).
 *
 * In the v3 CLI, detection triggers a forced retry with `toolChoice` to guarantee
 * the tool is called. In a streaming HTTP architecture (this codebase), retry
 * mid-stream is architecturally awkward — the response is already flowing to the
 * client. So this module focuses on detection + observability, allowing the
 * caller (e.g. the orchestrator's onStepFinish callback) to log and report.
 */

/**
 * Matches action claims followed by success language within a single sentence.
 * Examples that match:
 *   - "Stored client successfully."
 *   - "Created the rule — complete!"
 *   - "Selected the definition successfully."
 * Does NOT match:
 *   - "I will store this..." (future tense, no success claim)
 *   - "Stored: abc123" (no success word)
 */
const ACTION_CLAIM_PATTERN =
  /\b(stored|selected|created|updated|deleted)\b.*\b(successfully|complete|success)\b/i;

/**
 * Returns true if the text claims an action was completed but no tools were called.
 * This is the signature of an LLM hallucination.
 */
export function detectHallucination(
  text: string,
  toolCalls: unknown[] | undefined,
): boolean {
  if (!text) return false;
  if (toolCalls && toolCalls.length > 0) return false;
  return ACTION_CLAIM_PATTERN.test(text);
}
