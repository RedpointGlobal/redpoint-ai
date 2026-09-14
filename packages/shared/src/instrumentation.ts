/**
 * Economic-viability instrumentation spine.
 *
 * This is the pure, dependency-free core: the event shape, a pluggable sink
 * interface, and a tiny registry. It performs NO filesystem I/O, reads NO
 * `process.env`, and knows nothing about providers — a concrete sink (e.g. the
 * JSONL file sink in apps/server) is registered by the host at startup, and
 * only when the operator opts in via `INSTRUMENTATION_ENABLED`.
 *
 * The gate is "is a sink configured": when none is, `isInstrumentationEnabled()`
 * is false and `emitInstrumentationEvent()` is a near-zero-cost no-op. Capture
 * sites guard on `isInstrumentationEnabled()` BEFORE building an event, so a
 * build that never opts in pays nothing — no collection, no writes.
 *
 * This is per-call capture → a trivial local sink → offline analysis: a rough
 * cost-estimate probe, hand-collected. It is the complete deliverable — no
 * further phase, no central write path or shared store planned.
 */

/**
 * One usage record for a single LLM call — a parent turn or an `execute_skill`
 * sub-agent. Field set is the five identity columns plus the vendor's own
 * per-call token counts. NO cost/dollars are computed or stored and no pricing
 * ships — pricing these tokens is the operator's own downstream step.
 */
export interface InstrumentationEvent {
  // --- event identity ---
  /** Unique per event (UUID). */
  eventId: string;
  /** ISO 8601 UTC. */
  timestamp: string;
  /** Entra `sub`, or an OS-user/config fallback when unauthenticated. */
  userId: string;
  /** Client-supplied (`X-Idempotency-Key`) or `runId` fallback — the dedup key. */
  idempotencyKey: string;
  /**
   * The emitting channel/app — "web" (the probe captures rep-driven web traffic
   * only). NOT the tenant: the RPI/DRH split is carried by `workspaceId`.
   */
  clientId: string;

  // --- vendor-reported token counts ---
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;

  // --- correlation ---
  workspaceId: string;
  runId: string;
  /** Which call site emitted this, e.g. "parent" or "sub-agent". */
  role: string;
  /**
   * The dispatched skill, set only on `role:"sub-agent"` events (one per
   * `execute_skill` call). Enables cost-by-skill. Omitted on parent events.
   */
  skillName?: string;
}

/**
 * A destination for instrumentation events. Implementations MUST NOT throw into
 * the caller — `emitInstrumentationEvent` guards against it, but a well-behaved
 * sink swallows its own errors too (instrumentation must never break a request).
 */
export interface InstrumentationSink {
  write(event: InstrumentationEvent): void | Promise<void>;
  /** Optional flush/close for a buffering sink. No-op for the local file sink. */
  close?(): Promise<void>;
  /**
   * Optional cheap health probe: can the sink currently accept writes? Used by
   * the runtime-status endpoint for operator visibility. A sink that omits this
   * is assumed writable.
   */
  isWritable?(): Promise<boolean>;
}

// Module-level singleton. Null == disabled (the default). Set once at startup.
let activeSink: InstrumentationSink | null = null;

/**
 * Register the sink and turn instrumentation on, or pass `null` to turn it off.
 * Called once by the host at startup, only when `INSTRUMENTATION_ENABLED=true`.
 */
export function configureInstrumentation(sink: InstrumentationSink | null): void {
  activeSink = sink;
}

/**
 * Cheap boolean guard for capture sites: skip building an event entirely when
 * off. Check this FIRST, before extracting usage or computing cost.
 */
export function isInstrumentationEnabled(): boolean {
  return activeSink !== null;
}

/**
 * Probe whether the configured sink can currently accept writes (for
 * operator-visible health). Returns false when disabled; true when the sink
 * declares no probe; otherwise the sink's own `isWritable()` result (false on
 * throw). Never throws.
 */
export async function probeInstrumentationSink(): Promise<boolean> {
  const sink = activeSink;
  if (sink === null) return false;
  if (!sink.isWritable) return true;
  try {
    return await sink.isWritable();
  } catch {
    return false;
  }
}

/**
 * Emit one event. A near-zero-cost no-op when no sink is configured. Never
 * throws into the caller and never rejects — a sink failure must not break a
 * chat turn.
 */
export function emitInstrumentationEvent(event: InstrumentationEvent): void {
  const sink = activeSink;
  if (sink === null) return;
  try {
    const result = sink.write(event);
    if (result instanceof Promise) {
      result.catch(() => {
        /* swallow: instrumentation must not break the request */
      });
    }
  } catch {
    /* swallow: instrumentation must not break the request */
  }
}
