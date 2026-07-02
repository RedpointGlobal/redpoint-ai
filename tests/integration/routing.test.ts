/**
 * Routing accuracy + consistency tests (v1).
 *
 * Env-gated — skipIf(!RUN_ACCURACY_EVALUATION). One-tier suite: every
 * scenario runs at N=1 (2026-05-28 terminal reverse-port; coverage > stochastic
 * confidence at this gate). Pass-rate threshold via
 * `ACCURACY_EVALUATION_THRESHOLD` (default 0.8 — at N=1, effectively 1.0
 * since 0/1=0.0 fails and 1/1=1.0 passes).
 *
 * Force-fail probe via `ACCURACY_EVALUATION_FORCE_FAIL_ID=<scenario id>` —
 * sets that scenario's threshold to >1, guaranteeing a clean fail without
 * touching `scenarios.ts`. Lets us exercise the failure-log path on demand.
 */
import { beforeAll, describe, it, expect } from "bun:test";
import {
  accuracyEvaluationEnvOk,
  getAllDispatches,
  getFinalText,
  getRoutedSkill,
  getSubAgentToolCalls,
  looksClarifying,
  percentiles,
  resolveWorkspaceId,
  runN,
  runPrompt,
} from "./helpers.js";
import { selectScenarios } from "./scenarios.js";

const envCheck = accuracyEvaluationEnvOk();
const shouldSkip = !envCheck.ok;

const THRESHOLD = Number(process.env.ACCURACY_EVALUATION_THRESHOLD || "0.8");
const FORCE_FAIL_ID = process.env.ACCURACY_EVALUATION_FORCE_FAIL_ID || "";

// Flat 1h runaway safety net (2026-05-28 terminal reverse-port). NOT a gate —
// work is bounded by skill.maxSteps + Azure client timeout + maxRetries: 2
// retry-after waits. The 1h cap only catches genuinely hung work that the
// natural bounds didn't catch.
const TEST_TIMEOUT_MS = 60 * 60 * 1000;

describe.skipIf(shouldSkip)(`LLM accuracy — routing`, () => {
  if (shouldSkip) {
    console.log(`[accuracy-evaluation] skipped: ${envCheck.reason}`);
    return;
  }
  const { scenarios, n } = selectScenarios();
  console.log(
    `[accuracy-evaluation] running ${scenarios.length} scenarios × N=${n} (threshold=${THRESHOLD})` +
      (FORCE_FAIL_ID ? ` [FORCE_FAIL_ID=${FORCE_FAIL_ID}]` : ""),
  );

  // Resolve the benchmark workspace by name. Fail-loud: a missing target throws
  // here (RED) rather than letting the suite skip-to-green.
  beforeAll(async () => {
    await resolveWorkspaceId();
  }, TEST_TIMEOUT_MS);

  for (const sc of scenarios) {
    it(
      `[${sc.id}] "${sc.prompt}" → ${sc.expectedSkill ?? "clarifying-question"}`,
      async () => {
        const failFactory = (err: unknown) => ({
          passed: false,
          routed: null,
          allDispatches: [] as string[],
          subAgentToolCalls: [] as Array<{ toolName: string; args: unknown }>,
          durationMs: 0,
          finalText: "",
          parentText: "",
          traceEvents: [] as Awaited<ReturnType<typeof runPrompt>>["traceEvents"],
          firstDispatchDeviation: false,
          streamStats: {
            totalBytes: 0,
            frameCountsByType: {} as Record<string, number>,
            headSnapshot: "",
          },
          error: err instanceof Error ? err.message : String(err),
        });

        const { results, passRate, latencies, errors } = await runN(
          n,
          async () => {
          const { traceEvents, durationMs, parentText, streamStats } =
            await runPrompt(sc.prompt);
          // Probe-pace gate fires BEFORE this body via runN's wrapper.
          const routed = getRoutedSkill(traceEvents);
          const allDispatches = getAllDispatches(traceEvents);
          const subAgentToolCalls = getSubAgentToolCalls(traceEvents);
          const finalText = getFinalText(traceEvents);

          let passed: boolean;
          // firstDispatchDeviation = TRUE iff the agent dispatched the
          // wrong skill first AND self-corrected to the right one later
          // in the chain. Tracked as a side metric (not gating) so we
          // see LLM-typo-class flakes without false-positive routing
          // failures. See the assertion-shape comment block below.
          let firstDispatchDeviation = false;
          if (sc.expectedSkill === null) {
            // Ambiguous: must NOT dispatch any execute_skill AND parent must
            // have spoken (a silent crash should not green via "zero dispatch").
            passed = looksClarifying(traceEvents, parentText);
          } else {
            // Routing assertion measures INTENT + DELIVERY, not first-
            // keystroke purity. `allDispatches.includes(expected)` passes
            // when the agent eventually landed on the right skill — even
            // if it typo'd the skill name first and self-corrected (a real
            // class observed in the full tier 2026-05-26 on `list-selection-rules`).
            const routingOk = allDispatches.includes(sc.expectedSkill);
            if (routingOk && routed !== sc.expectedSkill) {
              firstDispatchDeviation = true;
            }
            const textOk =
              !sc.textNonEmpty || (finalText && finalText.length > 0);
            const containsOk =
              !sc.textContains ||
              finalText.toLowerCase().includes(sc.textContains.toLowerCase());
            passed = !!(routingOk && textOk && containsOk);
          }
          return {
            passed,
            routed,
            allDispatches,
            subAgentToolCalls,
            durationMs,
            finalText,
            parentText,
            traceEvents,
            firstDispatchDeviation,
            streamStats,
            error: undefined as string | undefined,
          };
        },
          failFactory,
          `routing:${sc.id}`,
        );

        const { p50, p95 } = percentiles(latencies);
        const routedSet = new Set(results.map((r) => r.routed ?? "(none)"));
        const firstDispatchDeviations = results.filter(
          (r) => r.firstDispatchDeviation,
        ).length;
        console.log(
          `  ${sc.id}: ${(passRate * 100).toFixed(0)}% pass (${results.filter((r) => r.passed).length}/${n}) ` +
            `· p50=${p50}ms p95=${p95}ms · routed=${[...routedSet].join("|")}` +
            (firstDispatchDeviations > 0
              ? ` · firstDispatchDeviations=${firstDispatchDeviations}/${n}`
              : "") +
            (sc.note ? ` · ${sc.note}` : ""),
        );

        // On any failed run, dump diagnostic state — allDispatches surfaces
        // chained dispatches the headline `routed=` line hides; the trace
        // dump (truncated per-event payload) explains empty-text races and
        // orphan outputs. Bound to failures only so happy paths stay quiet.
        const failed = results.filter((r) => !r.passed);
        if (failed.length > 0) {
          for (let i = 0; i < failed.length; i++) {
            const f = failed[i];
            const trimmed = f.traceEvents.map((e) => {
              const o: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
                const s = typeof v === "string" ? v : JSON.stringify(v);
                if (s !== undefined && s.length > 200) {
                  o[k] = s.slice(0, 200) + "…";
                } else {
                  o[k] = v;
                }
              }
              return o;
            });
            console.log(
              `    [fail ${i + 1}/${failed.length}] dispatches=${JSON.stringify(f.allDispatches)} ` +
                `parentTextLen=${f.parentText.length} finalTextLen=${f.finalText.length}` +
                (f.error ? ` error=${JSON.stringify(f.error)}` : ""),
            );
            // 2026-05-28 terminal reverse-port (Item 7): surface what tool the
            // sub-agent actually called when a routing scenario fails.
            // Without this, debugging is shoot-in-the-dark — the agent's
            // text shape rarely tells you which underlying MCP call landed
            // (or didn't). Trimmed at 500 chars to keep happy paths quiet.
            const subAgentToolsJson = JSON.stringify(f.subAgentToolCalls);
            console.log(
              `    [fail ${i + 1}/${failed.length}] subAgentToolCalls=` +
                (subAgentToolsJson.length > 500
                  ? subAgentToolsJson.slice(0, 500) + "…"
                  : subAgentToolsJson),
            );
            // Stream-level stats — added v1.0.3 for silent-run instrumentation.
            // Always logged on failure (cheap signal) so frame-count breakdown
            // is visible even on non-silent failures. Empty-stream detection
            // (traceEvents.length===1 && parentText==="") additionally logs
            // the raw head snapshot to inspect unparseable content.
            console.log(
              `    [fail ${i + 1}/${failed.length}] streamStats=` +
                JSON.stringify({
                  totalBytes: f.streamStats.totalBytes,
                  frameCountsByType: f.streamStats.frameCountsByType,
                }),
            );
            const isEmptyStream =
              f.traceEvents.length === 1 && f.parentText === "";
            if (isEmptyStream) {
              console.log(
                `    [empty-stream ${i + 1}/${failed.length}] head=` +
                  JSON.stringify(f.streamStats.headSnapshot),
              );
            }
            console.log(
              `    [fail ${i + 1}/${failed.length}] trace=` +
                JSON.stringify(trimmed),
            );
          }
        }

        // Force-fail override — env-var-driven, never edits scenarios.ts.
        // Sets threshold above 1.0 for the named scenario so any pass-rate
        // fails. Revert == unset the env var; nothing committed changes.
        const effectiveThreshold =
          FORCE_FAIL_ID === sc.id ? 1.01 : THRESHOLD;

        expect(
          passRate,
          `${sc.id} pass-rate ${(passRate * 100).toFixed(0)}% < threshold ${(effectiveThreshold * 100).toFixed(0)}%`,
        ).toBeGreaterThanOrEqual(effectiveThreshold);
      },
      // Assertion-shape policy — DO NOT tighten `routingOk` back to a
      // first-dispatch identity check (`routed === sc.expectedSkill`).
      // The full tier run on 2026-05-26 surfaced a real flake class on
      // `list-selection-rules`: agent typo'd the skill name on the first
      // dispatch (`rpi-selection-rrules`), router rejected with "Unknown
      // skill," agent self-corrected on the next step, delivered the
      // right answer to the user. User-facing SUCCESS, harness saw it
      // as a FAILURE because the first dispatch didn't match.
      // `allDispatches.includes(expected)` measures intent + delivery,
      // which is what the gate metric should reflect. The typo-class
      // is preserved as `firstDispatchDeviations=N/N` in the per-scenario
      // log line — surfaces flake without false-positive routing fails.
      //
      // Timeout policy — flat 1h runaway safety (2026-05-28 terminal reverse-
      // port). The prior PER_RUN_CANCEL_MS / OUTER_TIMEOUT_PER_N_MS pair
      // was arbitrary; work is bounded by skill.maxSteps + Azure client
      // timeout + sub-agent maxRetries: 2 retry-after waits. The 1h cap
      // catches only genuinely hung work. Per-iteration error trap in
      // runN's failFactory keeps one timeout from killing remaining
      // iterations.
      TEST_TIMEOUT_MS,
    );
  }
});
