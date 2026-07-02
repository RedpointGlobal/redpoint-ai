# LLM accuracy-evaluation integration tests

Env-gated `*.test.ts` files. Skip-by-default; run on demand against a
running stack. **Not in regular CI** — they make real LLM calls (token cost,
wall-time, non-determinism would flake CI).

## Run

```bash
# Stack must be up (bun run dev) and the "RedpointAI" workspace seeded (default seed).
# The workspace is resolved BY NAME at suite startup — no UUID to thread in.
bun run test:accuracy-evaluation

# Optional:
ACCURACY_EVALUATION_WORKSPACE_NAME=RedpointAI  # benchmark target (default "RedpointAI"); resolved to
                                               # an id via GET /api/v1/workspaces. A missing target
                                               # THROWS (RED) — the suite never silent-skips to green.
ACCURACY_EVALUATION_THRESHOLD=0.8           # pass-rate floor (default 0.8 — at N=1, effectively 1.0)
ACCURACY_EVALUATION_API_KEY=rpai_...        # required unless server has AUTH_REQUIRED=false
ACCURACY_EVALUATION_BASE_URL=http://...     # default http://localhost:3000
ACCURACY_EVALUATION_FORCE_FAIL_ID=<id>      # probe: forces named scenario to fail

# Probe-paced quota gate (default ON; see "Probe-paced quota gate" section)
ACCURACY_EVALUATION_PROBE_PACE=TRUE         # default TRUE; set FALSE to disable
ACCURACY_EVALUATION_GATE_PCT=0.9            # default 0.9 (0.0-1.0; 1.0 = strict reset=0)
```

**One-tier suite (2026-05-28):** every scenario runs once (N=1). Coverage
beats stochastic statistical confidence at this gate. Humans never burst
the same query 5-10× in a minute; N>1 + a threshold gate lets one-in-five
flakes pass averaged out. Single-N catches what would otherwise be smoothed
— the fix lands at the underlying agent / SKILL.md instead.

## What it tests

Two sibling test files, both gated by `RUN_ACCURACY_EVALUATION=1`:

- **`routing.test.ts`** — routing accuracy + consistency. Each
  scenario sends a prompt via the real chat endpoint, captures the
  workspace trace, asserts the agent dispatched to `expectedSkill`
  (via `allDispatches.includes` — accepts LLM-typo self-corrections;
  reports `firstDispatchDeviations` as a side metric). 14 scenarios cover
  list-class verbs, the count-routing fix guard, 4 Tier-A
  domain-recognition / sub-skill scenarios (v1.1.4), and 2 misrouting
  guards for the SKILL.md authoring discipline
  (`routing-audience-via-interaction`, `routing-interaction-run-counts`).

- **`chain.test.ts`** — name-prompted list → get-by-name chains
  (v1.1.3). `beforeAll` runs a one-shot cache pre-flight per cacheKey
  (`clients` / `audiences` / `interactions` / `selectionRules`) and
  reads the first record's name directly from the RPI Integration API
  JSON (Option B — no markdown scraping, zero LLM coupling).
  Each scenario then prompts the agent
  with that discovered name and asserts **Path A** — dispatch + name in
  response text + a matching `rpi__get_<entity>_by_(name|id)` call in
  `subAgentToolCalls` with the cached name in the args. Workspace-empty
  for an entity type → scenario logs SKIP (never fails).

The Path A tool-call assertion is powered by **v1.4 minimal sub-agent
telemetry** (`packages/skills/src/router.ts` — `createSkillRouterTool`
returns a `subAgentToolCalls` summary flattened across all steps; parent's
existing `execute_skill` trace event auto-serializes it). This skips the
full v1.5 (AsyncLocalStorage + agentLayer marker) approach; return-field
propagation is enough for current chain-test needs.

## Volume (N=1)

| File | Scenarios | N | LLM calls |
|---|---|---|---|
| `routing.test.ts` | 14 | 1 | 14 |
| `chain.test.ts`   | 4 | 1 | 4 |
| Cache pre-flight (chains)  | 4 | — | 0 (direct RPI API, no LLM) |
| **Total** | **18** | — | **~18** |

Typical wall: 10-15 min depending on Azure latency and per-scenario p50.

## Probe-paced quota gate

Before each iteration, the eval probes Azure directly for live rate-limit
state (`x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`,
`x-ratelimit-reset-tokens`, `retry-after`) via a 1-token completion call.
If the remaining-tokens fraction is below `ACCURACY_EVALUATION_GATE_PCT`
(default 0.9), the gate sleeps until reset before letting the iteration
fire. Self-tunes per-deployment — portable across dev / staging / prod tiers
with zero edits.

**Why:** RP_AI's web users share the same Azure deployment as the eval
suite. Without probe-pace, an eval run during peak contention can hit
sustained 429s on chain. Probe-pace lets the eval observe live bucket
state and pace itself — same protection the production product needs.

**Direct-Azure path:** the probe hits Azure directly (Path 2), not through
the RP_AI chat route. Reads `AZURE_OPENAI_RESOURCE_NAME`,
`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT_ID`, and
`AZURE_OPENAI_API_VERSION` (default `2024-10-01-preview`) from the
environment. Falls through cleanly (logs "probe unavailable") when any of
those is unset — non-Azure backends or test runs without Azure config
simply skip the gate.

**Cost:** ~11 tokens per probe call (~0.1% of a 10K bucket; trivially less
on larger). Each per-scenario gate logs `cap=N rem=M (P%) reset=Ss` so
operators can see live state at runtime.

**Tunables** (all env-var, all with sensible defaults):

| Env var | Default | What |
|---|---|---|
| `ACCURACY_EVALUATION_PROBE_PACE` | `TRUE` | `FALSE` disables the gate entirely |
| `ACCURACY_EVALUATION_GATE_PCT` | `0.9` | Remaining-tokens fraction required to proceed |
| `ACCURACY_EVALUATION_PROBE_FETCH_TIMEOUT_MS` | `10000` | Per-probe network timeout |
| `ACCURACY_EVALUATION_PROBE_TOTAL_CAP_MS` | `300000` (5 min) | Max total time waiting at the gate; beyond, log and proceed |
| `ACCURACY_EVALUATION_PROBE_SLEEP_MARGIN_S` | `2` | Seconds added past reset window before re-probing |
| `ACCURACY_EVALUATION_PROBE_SLEEP_CAP_MS` | `60000` | Per-sleep cap so a stuck reset header doesn't park us forever |

## Timeout policy

Flat 1h runaway safety net per test (`TEST_TIMEOUT_MS = 60 * 60 * 1000`).
NOT a gate — work is already bounded by:

- `skill.maxSteps` (declared in each SKILL.md frontmatter)
- Each LLM call's Azure client timeout
- Sub-agent `maxRetries: 2` retry-after waits

The 1h cap catches only genuinely hung work that the natural bounds didn't
catch. The prior `PER_RUN_CANCEL_MS = 100s` + `OUTER_TIMEOUT_PER_N_MS × N`
pair was arbitrary and nearly bit at stress (`audiences-with-counts-gt-0`
p95 hit 100.2s, touching the per-run cancel ceiling); dropped 2026-05-28.

Per-iteration error trap in `runN`'s `failFactory` keeps one timeout or
provider 429-after-retries from killing remaining iterations.

## Scope (post v1.1.1 scrub)

This framework owns **agent-layer** measurement — dispatch correctness,
response shape, routing stability across LLM stochasticity, and chain
plumbing via sub-agent tool-call inspection. Endpoint correctness (list /
get-by-id / chained tool flows at the API layer) is covered by the RPI MCP
integration suite at `packages/mcp-rpi/src/__tests__/integration/` and stays
there; we don't duplicate it.

## Scenario design discipline

Scenarios must target tools whose **required params can be satisfied from
the generic prompt** (no required entity-specific IDs), OR must
pre-discover required IDs via cache pre-flight before the prompt fires.
Tools requiring IDs the prompt doesn't provide will fail by design — not
because the agent regressed, but because the agent correctly refuses to
fabricate. v1.1.2.1 scrub dropped 3 scenarios that violated this rule
(workflowAssociationInstanceId / interactionIds[] / rule ID); kept
`routing-admin-diagnostics` because `get_cluster_api_error_log` has zero
required params.

For chain tests, pattern is: cache pre-flight discovers `{name}` by
calling the RPI Integration API directly (no agent/LLM), the prompt uses
the discovered name, and the assertion verifies the agent passed it
through to a `get_<entity>_by_*` call (via v1.4's `subAgentToolCalls`
propagation).

v1.5 sub-agent telemetry (full AsyncLocalStorage + `agentLayer` marker)
stays HOLD. v1.4 (minimal return-field propagation) is the active path —
sufficient until a future feature needs cross-cutting async telemetry.
