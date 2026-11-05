/**
 * Validate a caller's RPI token with RPI (validate-token-status), resolving the
 * caller's STABLE identity (the RPI user GUID), with the bounds the RPI MCP
 * server proved (its client/rpi-auth.ts checkToken, 7.211):
 *
 *   - a CACHE of answers (30 s), at most MAX_VALIDATION_CACHE_ENTRIES tokens: expired
 *     entries are swept, and past the cap the least recently used goes first;
 *   - SINGLE-FLIGHT: concurrent requests with one token share one RPI call;
 *   - only a NEW remote validation asks `admit` (the ValidationGuard budgets) — a
 *     cached or in-flight answer costs RPI nothing; a refusal never calls RPI;
 *   - a network error or timeout is "unavailable" and is NOT cached: a transient
 *     RPI stall must not lock a valid user out for the TTL.
 *
 * "valid" carries the stable id. Any non-ok answer from RPI, or an ok one without a
 * usable id (absent, or RPI's empty-GUID sentinel), is "invalid" (cached).
 */
import { createHash } from "crypto";

export type TokenCheck =
  | { result: "valid"; stableId: string }
  | { result: "invalid" }
  | { result: "unavailable" }
  | { result: "refused"; retryAfterSec: number };

/** Asked once before a NEW remote validation; its `settle` is told the answer. */
export type RemoteAdmission = () =>
  | { ok: true; settle?(result: TokenCheck["result"]): void }
  | { ok: false; retryAfterSec: number };

const VALIDATION_CACHE_TTL_MS = 30_000;
const VALIDATION_FETCH_TIMEOUT_MS = 8_000;
export const MAX_VALIDATION_CACHE_ENTRIES = 10_000;
/** RPI's empty/default GUID: a validated token that resolved NO principal. */
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

const cache = new Map<string, { stableId: string | null; expiresAt: number }>();
const inFlight = new Map<string, Promise<TokenCheck>>();

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Check `token` against the RPI instance at `base` (no /api/v2 suffix). */
export async function checkRpiToken(token: string, base: string, admit?: RemoteAdmission): Promise<TokenCheck> {
  const key = `${base}::${tokenHash(token)}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    cache.delete(key); // re-insert → most recently used
    cache.set(key, cached);
    return cached.stableId ? { result: "valid", stableId: cached.stableId } : { result: "invalid" };
  }

  let pending = inFlight.get(key);
  if (!pending) {
    const admission = admit?.();
    if (admission && !admission.ok) return { result: "refused", retryAfterSec: admission.retryAfterSec };
    const settle = admission?.settle;
    const started = validateRemotely(token, base, key).then(
      (check) => (settle?.(check.result), check),
      (error) => {
        settle?.("unavailable");
        throw error;
      },
    );
    pending = started.finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

async function validateRemotely(token: string, base: string, key: string): Promise<TokenCheck> {
  let stableId: string | null = null;
  try {
    const res = await fetch(`${base}/api/v2/authentication/validate-token-status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(VALIDATION_FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      // GUIDs are case-insensitive — normalise so a casing flip can't re-split one identity.
      const body = (await res.json().catch(() => ({}))) as { id?: string | null };
      const raw = body?.id?.trim().toLowerCase();
      if (raw && raw !== EMPTY_GUID) stableId = raw;
    }
  } catch {
    return { result: "unavailable" }; // not cached: the next request asks again
  }

  cache.delete(key);
  cache.set(key, { stableId, expiresAt: Date.now() + VALIDATION_CACHE_TTL_MS });
  if (cache.size > 100) {
    const now = Date.now();
    for (const [k, v] of cache) if (now >= v.expiresAt) cache.delete(k);
  }
  for (const k of cache.keys()) {
    if (cache.size <= MAX_VALIDATION_CACHE_ENTRIES) break;
    cache.delete(k);
  }
  return stableId ? { result: "valid", stableId } : { result: "invalid" };
}

/** How many tokens the cache holds (tests). */
export function validationCacheSize(): number {
  return cache.size;
}

/** Empty the cache (tests). */
export function resetValidationCache(): void {
  cache.clear();
  inFlight.clear();
}
