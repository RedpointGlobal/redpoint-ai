import os from "node:os";
import type { AuthUser } from "../middleware/auth.js";

/**
 * Context helpers for instrumentation events. Pure functions —
 * they read what the caller passes and never touch a sink or the gate.
 */

/** Request header carrying a client-supplied idempotency key. */
export const IDEMPOTENCY_HEADER = "X-Idempotency-Key";

// The auth middleware sets this id when AUTH_REQUIRED=false; it's a placeholder,
// not a real principal, so we attribute to the OS user instead.
const DEV_USER_PLACEHOLDER = "dev-user";

/**
 * Resolve the billing `userId` for an event.
 *
 * Resolution order:
 *   1. authenticated principal id — Entra `sub` for OIDC (see `authMiddleware`),
 *      or the API-key record id.
 *   2. `INSTRUMENTATION_USER_ID` env — an env-configured identity tier. Essential
 *      in a shared image: the container runs as `USER bun`, so the OS username
 *      collapses to the constant `"bun"` for every tester and per-user attribution
 *      dies. Each tester sets this in their own deployment's `.env`.
 *   3. OS username, prefixed `os:` so a local-dev attribution is never mistaken
 *      for a real Entra `sub` in analysis.
 *   4. `"unknown"`.
 */
export function resolveUserId(user: AuthUser | undefined): string {
  const id = user?.id;
  if (id && id !== DEV_USER_PLACEHOLDER) return id;
  const envId = process.env.INSTRUMENTATION_USER_ID?.trim();
  if (envId) return envId;
  try {
    const osUser = os.userInfo().username;
    if (osUser) return `os:${osUser}`;
  } catch {
    /* os.userInfo can throw if there's no passwd entry — fall through */
  }
  return "unknown";
}

/**
 * Resolve the idempotency key: the client-supplied `X-Idempotency-Key` header if
 * present and non-blank, otherwise the run id. This is the dedup key that lets
 * the offline report collapse retries of the same logical request.
 */
export function resolveIdempotencyKey(
  headerValue: string | undefined | null,
  runId: string,
): string {
  const trimmed = headerValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : runId;
}

/**
 * The emitting channel/app — a `clientId` label for the capture site. This is NOT
 * the tenant: the RPI/DRH split is already carried by `workspaceId`. The probe
 * captures only rep-driven web traffic, so the sole channel is "web" (the parent
 * turn and its execute_skill sub-agents both emit under it).
 */
export type InstrumentationChannel = "web";

/** The subset of AI SDK usage we read — structural so any call site's usage fits. */
export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}

/**
 * Extract the six token dimensions from an AI SDK usage object, each read-and-
 * defaulted to 0. `reasoningTokens` auto-populates from `outputTokenDetails` if a
 * reasoning model ever surfaces it — it is NOT hardcoded 0. `totalTokens` falls
 * back to input+output when the provider omits it.
 */
export function extractTokenCounts(usage: UsageLike): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
} {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
  };
}
