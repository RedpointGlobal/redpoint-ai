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
  getOrchestratorToolCalls,
  looksClarifying,
  percentiles,
  resolveWorkspaceId,
  resolveWorkspaceIdByName,
  isWorkspaceUsable,
  runN,
  runPrompt,
} from "./helpers.js";
import { selectScenarios, selectDrhScenarios, DRH_SCENARIOS } from "./scenarios.js";
// Relative, not the workspace alias — tests/ is not a workspace package.
import { WORKSPACE_NAMES } from "../../packages/shared/src/index.js";

const envCheck = accuracyEvaluationEnvOk();
const shouldSkip = !envCheck.ok;

// Data Readiness Hub scenarios only pass when mcp-drh is actually reachable
// (DRH workspace's MCP connection live with tools). The old design let them
// early-return green when it wasn't — a test with no expect(), which reads as a
// pass and makes the eval's exit code untrustworthy. Probe reachability HERE, at
// collection time (top-level await; the server is already healthy before the
// eval starts), and gate the whole block on a NATIVE describe.skipIf. Reachable
// → the block runs exactly as before; not reachable → bun reports 7 SKIPS, not 7
// silent passes, so pass-count == expect()-count. Auto-detect is preserved: any
// harness that DOES start mcp-drh still runs them. Probe only on the eval path
// (shouldSkip=false) so a normal `bun run test` never makes a network call here.
let drhUsable = false;
if (!shouldSkip) {
  try {
    const drhId = await resolveWorkspaceIdByName(WORKSPACE_NAMES.drh);
    drhUsable = !!(drhId && (await isWorkspaceUsable(drhId)));
  } catch {
    drhUsable = false;
  }
  if (!drhUsable) {
    console.log(
      `[accuracy-evaluation] ${DRH_SCENARIOS.length} Data Readiness Hub scenarios SKIPPED (native): ` +
        `mcp-drh not reachable (server on :3003 down or workspace MCP not connected). ` +
        `Start mcp-drh with DRH configured to run them.`,
    );
  }
}

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
      `[${sc.id}] "${sc.prompt}" → ${
        sc.expectedSkill ??
        (sc.expectedOrchestratorToolPattern ? "orchestrator-tool" : "clarifying-question")
      }`,
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
          if (sc.expectedOrchestratorToolPattern) {
            // Phase 2 (#27957) orchestrator-tool routing: a dashboard prompt routes
            // to render_view_dashboard DIRECTLY (no execute_skill). Assert the parent
            // called the expected tool with the expected viewId — the routing DECISION.
            const orch = getOrchestratorToolCalls(traceEvents);
            passed = orch.some(
              (t) =>
                sc.expectedOrchestratorToolPattern!.test(t.toolName) &&
                (!sc.expectedViewId ||
                  (t.args as { viewId?: string } | undefined)?.viewId ===
                    sc.expectedViewId),
            );
          } else if (sc.expectedSkill === null) {
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
            // Tool-hit guard (#27634): when a scenario pins expectedToolNamePattern,
            // the sub-agent must have called that exact (namespaced) MCP tool —
            // proves the description routed to the right tool, not just the skill.
            // Backward-compatible: undefined pattern → toolHitOk true (the existing
            // 14 scenarios are unaffected). Mirrors the DRH block below.
            const toolHitOk =
              !sc.expectedToolNamePattern ||
              subAgentToolCalls.some((t) =>
                sc.expectedToolNamePattern!.test(t.toolName),
              );
            // Negative tool-hit guard: a forbidden tool must NOT have been called
            // (e.g. a plain connection check must not invoke the cluster-admin
            // health tool). Undefined pattern → true (unaffected).
            const forbiddenToolOk =
              !sc.forbiddenToolNamePattern ||
              !subAgentToolCalls.some((t) =>
                sc.forbiddenToolNamePattern!.test(t.toolName),
              );
            passed = !!(
              routingOk &&
              textOk &&
              containsOk &&
              toolHitOk &&
              forbiddenToolOk
            );
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

// ---------------------------------------------------------------------------
// Data Readiness Hub two-layer routing. Skipped unless that workspace exists (seeded
// when Data Readiness Hub is configured — DRH_API_URL set + the mcp-drh server on :3003) — a
// normal single-workspace run never resolves it, so every scenario no-ops green.
// Proves, against a SECOND domain/workspace: WHAT → drh-domain-expert (which
// answers from the curated corpus (and refuses off-corpus via the shared
// GROUNDING_PREAMBLE) — injecting for a 2nd
// expert), HOW → drh-datasources calling a real drh__ tool, and — every Data Readiness Hub
// turn — NO rpi__ tool leak (cross-workspace tool isolation). The reverse (an RPI
// turn touching a drh__ tool) holds by construction: drh tools live only on the
// Data Readiness Hub workspace's mcp connection.
// ---------------------------------------------------------------------------
describe.skipIf(shouldSkip || !drhUsable)(`LLM accuracy — Data Readiness Hub two-layer routing`, () => {
  if (shouldSkip || !drhUsable) return;
  const { scenarios, n } = selectDrhScenarios();
  let drhWorkspaceId: string | null = null;

  beforeAll(async () => {
    // Gate on DRH being USABLE, not on the workspace existing. The seed now
    // creates that workspace unconditionally (so a missing DRH_API_URL can no
    // longer delete it), which means absence — the old skip signal — never
    // happens and these scenarios would run against an unconfigured DRH.
    const id = await resolveWorkspaceIdByName(WORKSPACE_NAMES.drh);
    drhWorkspaceId = id && (await isWorkspaceUsable(id)) ? id : null;
    if (drhWorkspaceId) {
      console.log(
        `[accuracy-evaluation] running ${scenarios.length} Data Readiness Hub scenarios × N=${n}`,
      );
    } else {
      // A skip must never read as a pass — name the cause and the count. Two
      // distinct causes now that the DRH card is gated on DRH_API_URL:
      //   id === null → workspace NOT LISTED (DRH_API_URL unset → card filtered
      //                 off GET /workspaces). This is the unprovisioned case.
      //   id !== null → listed but the mcp-drh server on :3003 isn't reachable
      //                 (down, or DRH_API_URL set but other DRH vars missing).
      const cause =
        id === null
          ? `workspace not listed (DRH_API_URL unset → Data Readiness Hub card gated off GET /workspaces)`
          : `workspace listed but not reachable (mcp-drh on :3003 down or partially configured)`;
      console.log(
        `[accuracy-evaluation] ${scenarios.length} Data Readiness Hub scenarios SKIPPED: ${cause}. ` +
          `Enable by configuring Data Readiness Hub (DRH_API_URL + DRH creds) with the mcp-drh server on :3003.`,
      );
    }
  }, TEST_TIMEOUT_MS);

  for (const sc of scenarios) {
    it(
      `[${sc.id}] "${sc.prompt}" → ${sc.expectedSkill}`,
      async () => {
        if (!drhWorkspaceId) {
          console.log(`  ${sc.id}: [skip — Data Readiness Hub not reachable]`);
          return;
        }
        const wsId = drhWorkspaceId;
        const failFactory = (err: unknown) => ({
          passed: false,
          allDispatches: [] as string[],
          toolNames: [] as string[],
          leaked: [] as string[],
          toolHitOk: false,
          finalText: "",
          error: err instanceof Error ? err.message : String(err),
        });

        const { results, passRate } = await runN(
          n,
          async () => {
            const { traceEvents } = await runPrompt(sc.prompt, {
              workspaceId: wsId,
            });
            const allDispatches = getAllDispatches(traceEvents);
            const subAgentToolCalls = getSubAgentToolCalls(traceEvents);
            const finalText = getFinalText(traceEvents);
            const toolNames = subAgentToolCalls.map((t) => t.toolName);

            const routingOk = allDispatches.includes(sc.expectedSkill!);
            const textOk = !sc.textNonEmpty || (finalText && finalText.length > 0);
            const containsOk =
              !sc.textContains ||
              finalText.toLowerCase().includes(sc.textContains.toLowerCase());
            // Tool-hit guard: routing accuracy isn't just which skill — it's
            // that the sub-agent actually reached the stub tool. Deterministic
            // proof we hit the mcp-drh server, not merely dispatched the skill.
            const toolHitOk =
              !sc.expectedToolNamePattern ||
              toolNames.some((nm) => sc.expectedToolNamePattern!.test(nm));
            // Cross-workspace isolation: a Data Readiness Hub turn must call NO rpi__ tool.
            const leaked = toolNames.filter((nm) => /^rpi__/.test(nm));

            return {
              passed: !!(
                routingOk &&
                textOk &&
                containsOk &&
                toolHitOk &&
                leaked.length === 0
              ),
              allDispatches,
              toolNames,
              leaked,
              toolHitOk,
              finalText,
              error: undefined as string | undefined,
            };
          },
          failFactory,
          `drh:${sc.id}`,
        );

        const r0 = results[0];
        console.log(
          `  ${sc.id}: ${(passRate * 100).toFixed(0)}% pass · dispatches=${JSON.stringify(r0.allDispatches)}` +
            (sc.expectedToolNamePattern
              ? ` · toolHit=${r0.toolHitOk ? "yes" : "NO"} tools=${JSON.stringify(r0.toolNames)}`
              : "") +
            (r0.leaked.length ? ` · RPI-LEAK=${JSON.stringify(r0.leaked)}` : "") +
            (sc.note ? ` · ${sc.note}` : ""),
        );

        expect(
          passRate,
          `${sc.id} pass-rate ${(passRate * 100).toFixed(0)}% < ${(THRESHOLD * 100).toFixed(0)}% ` +
            `(dispatches=${JSON.stringify(r0.allDispatches)}, toolHit=${r0.toolHitOk}, tools=${JSON.stringify(r0.toolNames)}, ` +
            `leaked=${JSON.stringify(r0.leaked)}, textLen=${r0.finalText.length})`,
        ).toBeGreaterThanOrEqual(THRESHOLD);
      },
      TEST_TIMEOUT_MS,
    );
  }
});
