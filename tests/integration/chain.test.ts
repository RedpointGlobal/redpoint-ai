/**
 * Chain accuracy tests (v1.1.3) — name-prompted list → get-by-name flows.
 *
 * Each scenario prompts the agent with a record name discovered via
 * pre-flight cache, then asserts the agent (a) dispatched to the
 * expected skill, (b) returned text mentioning that name, and (c) the
 * sub-agent issued an MCP tool call matching `get_<entity>_by_(name|id)`
 * with the cached name as an arg value. Path (c) is the Bug-D-class
 * rigorous assertion enabled by v1.4 `subAgentToolCalls` telemetry.
 *
 * Env-gated identically to the routing test. One-tier suite: N=1
 * (2026-05-28 terminal reverse-port).
 *
 * Workspace-portable: name is discovered dynamically. Empty workspace
 * (zero records of an entity type) → scenario skips, never fails.
 */
import { beforeAll, describe, it, expect } from "bun:test";
import {
  accuracyEvaluationEnvOk,
  buildChainCache,
  getAllDispatches,
  getChainCache,
  getFinalText,
  getSubAgentToolCalls,
  percentiles,
  resolveWorkspaceId,
  runN,
  runPrompt,
} from "./helpers.js";
import { selectChainScenarios } from "./scenarios.js";

const envCheck = accuracyEvaluationEnvOk();
const shouldSkip = !envCheck.ok;

const THRESHOLD = Number(process.env.ACCURACY_EVALUATION_THRESHOLD || "0.8");

// Flat 1h runaway safety net (2026-05-28 terminal reverse-port). See
// routing.test.ts for the full rationale.
const TEST_TIMEOUT_MS = 60 * 60 * 1000;

describe.skipIf(shouldSkip)(`LLM accuracy — chains`, () => {
  if (shouldSkip) {
    console.log(`[accuracy-evaluation/chains] skipped: ${envCheck.reason}`);
    return;
  }
  const { scenarios, n } = selectChainScenarios();
  console.log(
    `[accuracy-evaluation/chains] running ${scenarios.length} scenarios × N=${n} (threshold=${THRESHOLD})`,
  );

  beforeAll(
    async () => {
      // Resolve the benchmark workspace by name first — fail-loud (RED) on a
      // missing target instead of skip-to-green. Must precede any runPrompt /
      // trace call, which read the resolved id.
      await resolveWorkspaceId();
      // One round-trip per cacheKey, sequential. Provider rate-limits
      // concurrent multi-step calls per workspace, so parallel pre-flight
      // risks 429s for marginal wall-time gain. Cache is single-shot;
      // this hook runs once per test-file invocation.
      await buildChainCache([
        "clients",
        "audiences",
        "interactions",
        "selectionRules",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  for (const sc of scenarios) {
    it(
      `[${sc.id}]`,
      async () => {
        const cache = getChainCache(sc.cacheKey);
        if (!cache.name) {
          console.log(
            `  ${sc.id}: SKIP — no ${sc.cacheKey} records in workspace`,
          );
          return;
        }
        const prompt = sc.promptTemplate(cache.name);

        const failFactory = (err: unknown) => ({
          passed: false,
          routingOk: false,
          textNameOk: false,
          toolCallOk: false,
          allDispatches: [] as string[],
          durationMs: 0,
          finalText: "",
          parentText: "",
          traceEvents: [] as Awaited<ReturnType<typeof runPrompt>>["traceEvents"],
          streamStats: {
            totalBytes: 0,
            frameCountsByType: {} as Record<string, number>,
            headSnapshot: "",
          },
          subAgentToolCalls: [] as Array<{ toolName: string; args: unknown }>,
          error: err instanceof Error ? err.message : String(err),
        });

        const { results, passRate, latencies, errors } = await runN(
          n,
          async () => {
          const { traceEvents, durationMs, parentText, streamStats } =
            await runPrompt(prompt);
          const allDispatches = getAllDispatches(traceEvents);
          const finalText = getFinalText(traceEvents);
          const subAgentToolCalls = getSubAgentToolCalls(traceEvents);

          const routingOk = allDispatches.includes(sc.expectedSkill);

          // Text-level proof: agent mentioned the cached name somewhere
          // (either in the sub-agent's result OR the parent's final text).
          // Lower-case compare for resilience.
          const nameLower = cache.name!.toLowerCase();
          const textNameOk =
            finalText.toLowerCase().includes(nameLower) ||
            parentText.toLowerCase().includes(nameLower);

          // Path A: sub-agent tool-call inspection. The agent must have
          // issued a matching tool call with the cached name embedded
          // somewhere in args. Accepts both _by_name (direct) and _by_id
          // (after a name → id resolution step).
          const toolCallOk = subAgentToolCalls.some((tc) => {
            if (!sc.expectedToolNamePattern.test(tc.toolName)) return false;
            const argsObj = (tc.args ?? {}) as Record<string, unknown>;
            return Object.values(argsObj).some(
              (v) =>
                typeof v === "string" &&
                v.toLowerCase().includes(nameLower),
            );
          });

          const passed = routingOk && textNameOk && toolCallOk;
          return {
            passed,
            routingOk,
            textNameOk,
            toolCallOk,
            allDispatches,
            durationMs,
            finalText,
            parentText,
            traceEvents,
            streamStats,
            subAgentToolCalls,
            error: undefined as string | undefined,
          };
        },
          failFactory,
          `chain:${sc.id}`,
        );

        const { p50, p95 } = percentiles(latencies);
        console.log(
          `  ${sc.id}: ${(passRate * 100).toFixed(0)}% pass (${results.filter((r) => r.passed).length}/${n}) ` +
            `· p50=${p50}ms p95=${p95}ms · cachedName="${cache.name}"` +
            (sc.note ? ` · ${sc.note}` : ""),
        );

        // Per-failure diagnostic: surface which of the three checks failed
        // and dump the sub-agent calls so the regression class is obvious.
        const failed = results.filter((r) => !r.passed);
        for (let i = 0; i < failed.length; i++) {
          const f = failed[i];
          console.log(
            `    [fail ${i + 1}/${failed.length}] routing=${f.routingOk} text-name=${f.textNameOk} tool-call=${f.toolCallOk} ` +
              `dispatches=${JSON.stringify(f.allDispatches)}` +
              (f.error ? ` error=${JSON.stringify(f.error)}` : ""),
          );
          console.log(
            `    [fail ${i + 1}/${failed.length}] subAgentToolCalls=${JSON.stringify(
              f.subAgentToolCalls.map((tc) => ({
                toolName: tc.toolName,
                argKeys: Object.keys((tc.args ?? {}) as object),
              })),
            )}`,
          );
        }

        expect(
          passRate,
          `${sc.id} pass-rate ${(passRate * 100).toFixed(0)}% < threshold ${(THRESHOLD * 100).toFixed(0)}%`,
        ).toBeGreaterThanOrEqual(THRESHOLD);
      },
      TEST_TIMEOUT_MS,
    );
  }
});
