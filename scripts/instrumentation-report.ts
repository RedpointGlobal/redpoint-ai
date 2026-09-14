#!/usr/bin/env bun
/**
 * bun run instrumentation:report — offline analysis of the economic-viability
 * instrumentation JSONL sink.
 *
 * Reads the sink (one InstrumentationEvent per line), applies the correct dedup
 * grain, and prints per-user / per-model / per-skill request + token totals with
 * the FULL token breakdown — input, cache-read, cache-write, output, reasoning,
 * total — so the numbers are cost-computable downstream.
 *
 * NO DOLLARS. This tool never computes or prints a cost figure and ships no
 * pricing. It reports the vendor's own per-call token counts (captured verbatim
 * from each provider response — nothing estimated). Turning tokens into money is
 * the operator's own step, applied to these numbers with their own rate card —
 * deliberately outside this tool so we never publish a rate we didn't verify.
 *
 * `cacheReadTokens` is a SUBSET of `inputTokens` (the cached portion of the
 * prompt, billed at a discount by the provider). It is surfaced as its own column
 * precisely so the cached share is visible and deductible — fresh input is
 * `input - cached`.
 *
 * The `net` column is `total - cached` — the non-cached token volume (fresh input
 * + output), i.e. the deduction pre-computed. It is an exact subtraction of two
 * vendor-reported counts, NOT a cost: fresh-input and output bill at different
 * rates, so `net` is a volume metric, not a dollar figure.
 *
 * Usage:
 *   bun run instrumentation:report [<file.jsonl>]
 *
 *   file  JSONL sink path. Default: $INSTRUMENTATION_SINK_PATH, else
 *         ./instrumentation-events.jsonl at the repo root.
 *
 * Dedup grain (critical — do NOT collapse to one row per key): a single request
 * emits MULTIPLE events sharing one idempotencyKey (1 parent + N sub-agents).
 * We group by idempotencyKey, keep the EARLIEST runId's whole event-set, and
 * drop later runIds as genuine retries. Parent + its sub-agents are preserved;
 * only re-submissions of the same logical request are dropped.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Local mirror of @redpoint-ai/shared's InstrumentationEvent (scripts avoid the
// bare workspace-specifier resolution; only the fields we read are typed).
export interface InstrumentationEvent {
  eventId: string;
  timestamp: string;
  userId: string;
  idempotencyKey: string;
  clientId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  workspaceId: string;
  runId: string;
  role: string;
  skillName?: string;
}

/** Parse a JSONL string into events, skipping blank/malformed lines. */
export function parseJsonl(text: string): InstrumentationEvent[] {
  const events: InstrumentationEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as InstrumentationEvent);
    } catch {
      /* skip a malformed line rather than abort the whole report */
    }
  }
  return events;
}

/**
 * Apply the dedup grain: group by idempotencyKey, keep the earliest runId's
 * whole event-set (by minimum timestamp within the key), drop later runIds.
 * Returns { kept, dropped }.
 */
export function dedupeByIdempotency(events: InstrumentationEvent[]): {
  kept: InstrumentationEvent[];
  dropped: number;
} {
  const byKey = new Map<string, InstrumentationEvent[]>();
  for (const e of events) {
    const arr = byKey.get(e.idempotencyKey);
    if (arr) arr.push(e);
    else byKey.set(e.idempotencyKey, [e]);
  }

  const kept: InstrumentationEvent[] = [];
  let dropped = 0;

  for (const group of byKey.values()) {
    // Earliest min-timestamp per runId → that runId is the first attempt.
    const minTsByRun = new Map<string, string>();
    for (const e of group) {
      const cur = minTsByRun.get(e.runId);
      if (cur === undefined || e.timestamp < cur) minTsByRun.set(e.runId, e.timestamp);
    }
    let earliestRun: string | undefined;
    let earliestTs: string | undefined;
    for (const [runId, ts] of minTsByRun) {
      if (earliestTs === undefined || ts < earliestTs) {
        earliestTs = ts;
        earliestRun = runId;
      }
    }
    for (const e of group) {
      if (e.runId === earliestRun) kept.push(e);
      else dropped++;
    }
  }

  return { kept, dropped };
}

interface Totals {
  requests: Set<string>; // distinct kept idempotencyKeys
  inputTokens: number; // total input (INCLUDES the cached subset below)
  cacheReadTokens: number; // cached portion of input (discounted by the provider)
  cacheWriteTokens: number; // cache-creation tokens (Anthropic; 0 on Azure/OpenAI)
  outputTokens: number;
  reasoningTokens: number; // subset of output (reasoning models); 0 otherwise
  totalTokens: number;
}

function newTotals(): Totals {
  return {
    requests: new Set(),
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function add(t: Totals, e: InstrumentationEvent): void {
  t.requests.add(e.idempotencyKey);
  t.inputTokens += e.inputTokens;
  t.cacheReadTokens += e.cacheReadTokens;
  t.cacheWriteTokens += e.cacheWriteTokens;
  t.outputTokens += e.outputTokens;
  t.reasoningTokens += e.reasoningTokens;
  t.totalTokens += e.totalTokens;
}

/** Aggregate kept events into per-dimension totals. */
export function aggregate(kept: InstrumentationEvent[]): {
  byUser: Map<string, Totals>;
  byModel: Map<string, Totals>;
  bySkill: Map<string, Totals>;
  grand: Totals;
} {
  const byUser = new Map<string, Totals>();
  const byModel = new Map<string, Totals>();
  const bySkill = new Map<string, Totals>();
  const grand = newTotals();

  const bump = (m: Map<string, Totals>, k: string, e: InstrumentationEvent) => {
    let t = m.get(k);
    if (!t) {
      t = newTotals();
      m.set(k, t);
    }
    add(t, e);
  };

  for (const e of kept) {
    bump(byUser, e.userId, e);
    bump(byModel, e.model, e);
    if (e.role === "sub-agent" && e.skillName) bump(bySkill, e.skillName, e);
    add(grand, e);
  }

  return { byUser, byModel, bySkill, grand };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function printTable(title: string, m: Map<string, Totals>, label: string): void {
  console.log(`\n${BOLD}${title}${RESET}`);
  if (m.size === 0) {
    console.log(`  ${DIM}(none)${RESET}`);
    return;
  }
  const rows = [...m.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  console.log(
    `  ${label.padEnd(22)} ${"reqs".padStart(5)} ${"input".padStart(10)} ${"cached".padStart(10)} ${"cacheWr".padStart(8)} ${"output".padStart(9)} ${"total".padStart(11)} ${"net".padStart(11)}`,
  );
  for (const [k, t] of rows) {
    const net = t.totalTokens - t.cacheReadTokens; // non-cached volume: fresh input + output
    console.log(
      `  ${k.slice(0, 22).padEnd(22)} ${String(t.requests.size).padStart(5)} ${fmt(t.inputTokens).padStart(10)} ${fmt(t.cacheReadTokens).padStart(10)} ${fmt(t.cacheWriteTokens).padStart(8)} ${fmt(t.outputTokens).padStart(9)} ${fmt(t.totalTokens).padStart(11)} ${fmt(net).padStart(11)}`,
    );
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith("--"));

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sinkPath =
    file ??
    process.env.INSTRUMENTATION_SINK_PATH ??
    join(repoRoot, "instrumentation-events.jsonl");

  if (!existsSync(sinkPath)) {
    console.error(`${DIM}No sink at ${sinkPath}${RESET}`);
    console.error(
      `Set INSTRUMENTATION_ENABLED=true and run some traffic, or pass a path.`,
    );
    process.exit(1);
  }

  const events = parseJsonl(readFileSync(sinkPath, "utf8"));
  const { kept, dropped } = dedupeByIdempotency(events);
  const { byUser, byModel, bySkill, grand } = aggregate(kept);

  console.log(`${BOLD}Instrumentation report${RESET}  ${DIM}${sinkPath}${RESET}`);
  console.log(
    `  ${GREEN}${fmt(events.length)}${RESET} events read · ` +
      `${GREEN}${fmt(kept.length)}${RESET} kept · ` +
      `${dropped > 0 ? "\x1b[33m" : ""}${fmt(dropped)}${RESET} dropped as retries · ` +
      `${GREEN}${fmt(grand.requests.size)}${RESET} distinct requests`,
  );
  console.log(
    `  ${DIM}token counts only (vendor-reported); no cost is computed. "cached" is the ` +
      `discounted subset of "input" — fresh input = input − cached.${RESET}`,
  );

  printTable("By user", byUser, "userId");
  printTable("By model", byModel, "model");
  printTable("By skill (sub-agent)", bySkill, "skillName");

  console.log(
    `\n${BOLD}Total${RESET}  ${fmt(grand.requests.size)} requests · ` +
      `input ${fmt(grand.inputTokens)} (cached ${fmt(grand.cacheReadTokens)}, ` +
      `cacheWrite ${fmt(grand.cacheWriteTokens)}) · ` +
      `output ${fmt(grand.outputTokens)} (reasoning ${fmt(grand.reasoningTokens)}) · ` +
      `total ${fmt(grand.totalTokens)} · ` +
      `net ${fmt(grand.totalTokens - grand.cacheReadTokens)}`,
  );
}

if (import.meta.main) main();
