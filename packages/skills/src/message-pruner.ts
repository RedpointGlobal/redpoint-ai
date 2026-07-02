/**
 * Message-array history management for ToolLoopAgent / generateText
 * (`prepareStep` hook). Without this, RP_AI chat sessions accumulate
 * tool results + history verbatim across turns and walk into gpt-4o's
 * 128K context cliff (real recipient overflow 2026-05-20 at 427K
 * message tokens; live capture 2026-05-21 14:41 confirmed the bloat
 * lives in the sub-agent's active-turn paginated-tool-loop, not in
 * estimator overcounting).
 *
 * Pruning order — designed so a buggy pruner CANNOT produce silent
 * wrong answers (the failure-mode asymmetry: silent-wrong is worse
 * than an explicit overflow error):
 *
 *   1. System messages — never prunable.
 *   2. Active user message (most-recent `user` in the array) — never
 *      prunable.
 *   3. Active-turn assistant tool-call parts — never truncated (small,
 *      and the LLM needs the call shape to interpret following
 *      results).
 *   4. Active-turn tool-result parts — when total exceeds budget,
 *      truncate ALL of them to a DYNAMIC per-part cap
 *      (`perPartCap = (budget − fixedReserved − safetyMargin) / N`).
 *      Every truncated part carries the structured marker
 *      `[truncated due to budget — N tokens dropped]` in
 *      `output.value` so the LLM sees STRUCTURED truncation, never an
 *      arbitrary cutoff. K=0 by construction — no "last K untouched"
 *      notion; the dynamic cap fits by math, not by hoping the tail
 *      is small. The Step-2B live capture proved K-based approaches
 *      can't reliably fit (top-3 single parts were 40K/39K/35K
 *      tokens — keeping any of them whole + 14K system + truncated
 *      siblings already exceeds 60K).
 *   5. Pre-active turn content — first truncate oldest `tool` result
 *      content to `toolResultCapTokens` (~2K each); then drop oldest
 *      prunable messages until total fits.
 *   6. Catastrophic case (system + minimally-truncated active turn
 *      still exceeds budget): throw `MessageBudgetExceeded`. Fail
 *      loud, never silently wrong.
 *
 * Persistence is unaffected — pruning only shapes the OUTGOING LLM
 * call. The `messages` table retains the full history for audit/UX.
 *
 * Estimator notes:
 *   Counts text the provider actually tokenizes — TextPart text,
 *   ToolCallPart name + args, ToolResultPart name + rendered output
 *   value — and ignores the SDK part envelope (`type` tags,
 *   `toolCallId`, `output.type` wrapper, `providerOptions`).
 */
import type { ModelMessage } from "ai";

/** Thrown when system + minimally-truncated active turn still exceed the budget. */
export class MessageBudgetExceeded extends Error {
  readonly required: number;
  readonly budget: number;
  constructor(required: number, budget: number) {
    super(
      `Message budget exceeded: ${required} tokens required, ${budget} budget ` +
        `(system + active turn cannot be pruned; failing loud rather than producing a silent wrong answer).`,
    );
    this.name = "MessageBudgetExceeded";
    this.required = required;
    this.budget = budget;
  }
}

const DEFAULT_BUDGET_TOKENS = 60_000; // ~half of gpt-4o's 128K — absorbs ±20% estimator drift.
const DEFAULT_TOOL_RESULT_CAP_TOKENS = 2_000;
const STRUCTURE_OVERHEAD_TOKENS = 4; // per-message envelope estimate.
const BINARY_PART_TOKENS = 256; // conservative ImagePart/FilePart overhead.

// Active-turn dynamic-cap constants (Step 3).
//
// SAFETY_MARGIN absorbs ±25% char/4 estimator drift on the ~15K fixed
// reservation (system prompt + active user + tool-call envelopes). A
// 5K cushion at a 60K budget = 8% of budget — well under any
// realistic drift, well within "not enough to matter to the LLM."
//
// MIN_TOOL_RESULT_CAP floors the per-part dynamic cap so it never
// collapses to zero on pathological N-many-parts cases (e.g. a
// hypothetical 100-part tool loop where (40K − 15K − 5K) / 100 = 200
// tokens). Floor at 256 = ~1KB of text per part — enough for the
// truncation marker plus a couple lines of structural context.
const SAFETY_MARGIN_TOKENS = 5_000;
const MIN_TOOL_RESULT_CAP_TOKENS = 256;

export interface PruneOptions {
  /** Total budget for the outgoing message array. Default 60_000. */
  budgetTokens?: number;
  /** Per-tool-result content cap for PRE-active-turn history. Default 2_000. */
  toolResultCapTokens?: number;
}

/**
 * Char/4 heuristic — fast, no dep, ±20% accuracy in practice. The
 * conservative default budget (60K vs 128K limit) absorbs the drift.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Total estimated tokens for a message array — exposed for both-bounds
 * calibration tests (Step 2A). Internal callers go through
 * `pruneMessageHistory`'s private `totalTokens` (same function,
 * different signature for clarity).
 */
export function estimateMessageArrayTokens(messages: readonly ModelMessage[]): number {
  return totalTokens(messages);
}

// ---------- Content rendering (envelope-free) ----------

function outputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output !== "object") return String(output);
  const o = output as { type?: string; value?: unknown; reason?: string };
  switch (o.type) {
    case "text":
    case "error-text":
      return typeof o.value === "string" ? o.value : "";
    case "json":
    case "error-json":
      return JSON.stringify(o.value ?? null);
    case "content":
      return Array.isArray(o.value)
        ? o.value
            .map((p) =>
              p && typeof p === "object" && "text" in p && typeof p.text === "string"
                ? p.text
                : "",
            )
            .join("")
        : "";
    case "execution-denied":
      return typeof o.reason === "string" ? o.reason : "";
    default:
      return JSON.stringify(o);
  }
}

function partText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const p = part as {
    type?: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
  };
  switch (p.type) {
    case "text":
    case "reasoning":
      return typeof p.text === "string" ? p.text : "";
    case "tool-call":
      return `${p.toolName ?? ""}(${JSON.stringify(p.input ?? {})})`;
    case "tool-result":
      return `${p.toolName ?? ""}: ${outputText(p.output)}`;
    case "image":
    case "file":
      return ""; // counted via BINARY_PART_TOKENS in partTokens.
    default:
      return JSON.stringify(p);
  }
}

function partTokens(part: unknown): number {
  if (!part || typeof part !== "object") return 0;
  const p = part as { type?: string };
  if (p.type === "image" || p.type === "file") return BINARY_PART_TOKENS;
  return estimateTokens(partText(part));
}

function renderContentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map(partText).join("\n");
}

function contentTokens(content: ModelMessage["content"]): number {
  if (typeof content === "string") return estimateTokens(content);
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content));
  let sum = 0;
  for (const part of content) sum += partTokens(part);
  return sum;
}

function estimateMessageTokens(m: ModelMessage): number {
  return contentTokens(m.content) + estimateTokens(m.role) + STRUCTURE_OVERHEAD_TOKENS;
}

function totalTokens(messages: readonly ModelMessage[]): number {
  let s = 0;
  for (const m of messages) s += estimateMessageTokens(m);
  return s;
}

/** Index of the most-recent `user` message (start of the active turn). */
function findActiveTurnStart(messages: readonly ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return messages.length; // no user message ⇒ everything is "pre-active" / safe to prune (degenerate case).
}

function truncationMarker(droppedTokens: number): string {
  return `\n\n[truncated due to budget — ${droppedTokens} tokens dropped]`;
}

/**
 * Truncate a single tool-result PART (not a whole message) to the
 * given per-part cap, rebuilding it as a `{type:"text"}` output with
 * the structured marker. Returns the same part reference when no
 * truncation needed.
 */
function truncateToolResultPart(part: unknown, capTokens: number): unknown {
  if (!part || typeof part !== "object") return part;
  const p = part as { type?: string; toolCallId?: string; toolName?: string; output?: unknown };
  if (p.type !== "tool-result") return part;
  const visible = outputText(p.output);
  const cur = estimateTokens(visible);
  if (cur <= capTokens) return part;
  const charCap = capTokens * 4;
  const truncated = visible.slice(0, charCap) + truncationMarker(cur - capTokens);
  return {
    type: "tool-result" as const,
    toolCallId: p.toolCallId ?? "",
    toolName: p.toolName ?? "",
    output: { type: "text" as const, value: truncated },
  };
}

/**
 * Walk a message's content array and apply tool-result truncation to
 * every tool-result part inside. Non-array content / non-tool-result
 * parts pass through.
 */
function truncateToolResultsInMessage(m: ModelMessage, capTokens: number): ModelMessage {
  if (!Array.isArray(m.content)) return m;
  const newContent = m.content.map((p) => truncateToolResultPart(p, capTokens));
  // Only tool-result parts are truncated in place — the object stays a valid
  // ModelMessage; assert at the object level because the SDK union can't narrow
  // {...m, content} (it can't tell content matches m's role variant).
  return { ...m, content: newContent } as ModelMessage;
}

/**
 * Count the tool-result parts inside the active-turn slice (messages
 * at index >= activeStart). Tool-result parts live inside `tool`-role
 * messages' content arrays.
 */
function countActiveToolResultParts(
  messages: readonly ModelMessage[],
  activeStart: number,
): number {
  let n = 0;
  for (let i = activeStart; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "tool-result") {
        n += 1;
      }
    }
  }
  return n;
}

/**
 * Prune a message array to fit within the budget. Returns the SAME
 * array reference (===) when no pruning is needed — callers can use
 * referential equality to detect no-op and pass `{}` to `prepareStep`.
 */
export function pruneMessageHistory(
  messages: ModelMessage[],
  opts: PruneOptions = {},
): ModelMessage[] {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const preActiveToolCap = opts.toolResultCapTokens ?? DEFAULT_TOOL_RESULT_CAP_TOKENS;

  if (totalTokens(messages) <= budget) return messages; // no-op fast path.

  const activeStart = findActiveTurnStart(messages);

  // Partition: system (always preserved), prunable (before active turn,
  // non-system), active (active turn onwards, NEVER pruned-out — but
  // tool-result parts within may be truncated below).
  const systemMsgs: ModelMessage[] = [];
  const prunable: ModelMessage[] = [];
  const active: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "system") systemMsgs.push(m);
    else if (i < activeStart) prunable.push(m);
    else active.push(m);
  }

  // Step 1 (pre-active): truncate oldest tool-result content.
  let preWorking = prunable.map((m) =>
    m.role === "tool" ? truncateToolResultsInMessage(m, preActiveToolCap) : m,
  );

  // Step 4 (active-turn dynamic cap): if the active turn alone has too
  // much tool-result content to fit, truncate ALL active-turn tool-
  // result parts to a per-part cap derived from the remaining budget.
  // This is the Step 3 fix — the prior "active turn is never
  // prunable" invariant didn't survive the live captured shape (18
  // paginated tool-results in a sub-agent loop = 394K tokens).
  let activeWorking = active;
  const activeToolResultCount = countActiveToolResultParts(messages, activeStart);
  if (activeToolResultCount > 0) {
    const systemAndUserTokens = totalTokens(systemMsgs) +
      activeWorking.reduce((s, m) => {
        // Reserve only the non-tool-result content (system role isn't in
        // active anyway; this covers the active user msg + assistant
        // tool-call parts + assistant text parts).
        if (!Array.isArray(m.content)) return s + estimateMessageTokens(m);
        let nonToolResult = estimateTokens(m.role) + STRUCTURE_OVERHEAD_TOKENS;
        for (const part of m.content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "tool-result") {
            continue; // skip — these are what we're capping below.
          }
          nonToolResult += partTokens(part);
        }
        return s + nonToolResult;
      }, 0);
    const remainingBudget = budget - systemAndUserTokens - SAFETY_MARGIN_TOKENS;
    const perPartCap = Math.max(
      MIN_TOOL_RESULT_CAP_TOKENS,
      Math.floor(remainingBudget / activeToolResultCount),
    );
    activeWorking = activeWorking.map((m) =>
      truncateToolResultsInMessage(m, perPartCap),
    );
  }

  const sizedAssembled = () => totalTokens([...systemMsgs, ...preWorking, ...activeWorking]);

  if (sizedAssembled() <= budget) {
    return [...systemMsgs, ...preWorking, ...activeWorking];
  }

  // Step 5 (pre-active): drop oldest prunable messages until total fits.
  let droppedCount = 0;
  while (preWorking.length > 0 && sizedAssembled() > budget) {
    preWorking.shift();
    droppedCount++;
  }

  if (sizedAssembled() > budget) {
    // Step 6: catastrophic — system + minimally-truncated active alone
    // exceed budget. Fail loud.
    throw new MessageBudgetExceeded(sizedAssembled(), budget);
  }

  // Step epilogue: record drop count as a system note.
  const note: ModelMessage[] = droppedCount > 0 ? [
    {
      role: "system",
      content:
        `[note: ${droppedCount} older message(s) dropped from this LLM call due to ` +
        `the ${budget}-token budget. Full history retained in the workspace store.]`,
    },
  ] : [];

  return [...systemMsgs, ...note, ...preWorking, ...activeWorking];
}
