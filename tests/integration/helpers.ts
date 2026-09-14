/**
 * Shared helpers for LLM accuracy-evaluation integration tests.
 *
 * Drives the real chat path (`POST /api/v1/workspaces/:id/chat`), consumes
 * the SSE stream to completion, and reads the per-workspace trace buffer
 * for structured telemetry. The trace buffer is the source of truth for
 * routing assertions — `getTrace` returns `TelemetryEvent[]` with
 * `tool-call` events that carry `skillName` in `args`.
 *
 * v1.0.1 adds:
 *  - AbortController + reader.cancel() so a test-layer timeout = hard cancel
 *    (closes the orphan-stream cross-scenario contamination risk).
 *  - Parent-text accumulation from the SSE stream. AI SDK v6 emits frames
 *    of shape `data: {"type":"text-delta","id":"0","delta":"..."}` separated
 *    by blank lines, with `data: [DONE]` as terminator (ground-truth verified
 *    against apps/server/src/routes/chat.ts on 2026-05-26). Needed to harden
 *    the ambiguous-prompt scenario (zero dispatch + non-empty parent text).
 *
 * Env (consumed by the tests, not here):
 *   RUN_ACCURACY_EVALUATION=1            — the ONLY gate; tests skipIf(!RUN_ACCURACY_EVALUATION).
 *                                          When set, the workspace is resolved by name (below);
 *                                          a missing/misconfigured target THROWS (RED), never skips.
 *   ACCURACY_EVALUATION_BASE_URL         — default http://localhost:3000
 *   ACCURACY_EVALUATION_WORKSPACE_NAME   — benchmark target, default WORKSPACE_NAMES.rpi; resolved to an id
 *                                          at suite startup via GET /api/v1/workspaces (resolveWorkspaceId).
 *   ACCURACY_EVALUATION_API_KEY          — rpai_… (skip if AUTH_REQUIRED=false on server)
 *   ACCURACY_EVALUATION_TIMEOUT_MS       — optional per-runPrompt hard cap; primarily for
 *                                          the falsifiable cancel-probe (set =1 to force abort).
 */
import type { TelemetryEvent } from "@redpoint-ai/shared";
// Value import, so it must resolve at RUNTIME. tests/ is not a workspace
// package, so the "@redpoint-ai/shared" alias does not resolve from here — the
// type-only import above is erased before that matters, which is why it looked
// fine. Use the relative path, matching the packages/mcp-rpi imports below.
import { WORKSPACE_NAMES } from "../../packages/shared/src/index.js";
import { RPIApiClient } from "../../packages/mcp-rpi/src/client/rpi-api.js";
import { RPIAuthService } from "../../packages/mcp-rpi/src/client/rpi-auth.js";
import { searchFileInfos } from "../../packages/mcp-rpi/src/client/search.js";

const BASE_URL =
  process.env.ACCURACY_EVALUATION_BASE_URL || "http://localhost:3000";
const WORKSPACE_NAME =
  process.env.ACCURACY_EVALUATION_WORKSPACE_NAME || WORKSPACE_NAMES.rpi;
const API_KEY = process.env.ACCURACY_EVALUATION_API_KEY || "";

// Resolved once at suite startup by resolveWorkspaceId() (a beforeAll in each
// test file); the trace/chat URL builders read it via getWorkspaceId(). Kept
// module-mutable, not a const-from-env: the id is discovered by NAME at runtime
// because the name is the stable contract — the seed's UUID is PRNG-volatile.
let _workspaceId = "";
// azureDeployment from the resolved workspace's config — the SAME source the
// agent runs on (DB row config.provider.azureDeployment). The quota probe gates
// on THIS so it follows deployment swaps (e.g. gpt-4o→gpt-4.1, a 10K→100K bucket
// change) instead of drifting against a stale env var. Empty → probe falls back
// to AZURE_OPENAI_DEPLOYMENT_ID.
let _workspaceDeployment = "";

/**
 * Gate split (2026-06-01): skip ONLY when the eval isn't requested. A requested-
 * but-misconfigured run must NOT skip-to-green here — workspace resolution is
 * deferred to resolveWorkspaceId(), which THROWS (RED) on a missing target. This
 * kills the silent-skip footgun where a bare `test:accuracy-evaluation` (intent
 * flag set, no workspace) exited 0 with zero tests.
 */
export function accuracyEvaluationEnvOk(): { ok: boolean; reason?: string } {
  if (!process.env.RUN_ACCURACY_EVALUATION) {
    return { ok: false, reason: "RUN_ACCURACY_EVALUATION not set" };
  }
  // ACCURACY_EVALUATION_API_KEY optional — server may have AUTH_REQUIRED=false in dev.
  // Workspace presence is NOT gated here — resolveWorkspaceId() fails loud instead.
  return { ok: true };
}

/** Workspace id resolved at suite startup; throws if read before resolution. */
export function getWorkspaceId(): string {
  if (!_workspaceId) {
    throw new Error(
      "accuracy-evaluation: workspace id not resolved — call resolveWorkspaceId() in beforeAll before any runPrompt()",
    );
  }
  return _workspaceId;
}

/**
 * Resolve the benchmark workspace id by NAME (default WORKSPACE_NAMES.rpi) via
 * GET /api/v1/workspaces. Fail-loud: throws if the list can't be fetched or the
 * named workspace is absent, so a requested-but-misconfigured eval goes RED
 * instead of skip-to-green. Selecting by name (not list[0]) means the eval can
 * never silently land on the wrong workspace — e.g. the seed's skill-less
 * "General Assistant", which would "measure nothing." Idempotent.
 */
export async function resolveWorkspaceId(): Promise<string> {
  if (_workspaceId) return _workspaceId;
  const url = `${BASE_URL}/api/v1/workspaces`;
  let res: Response;
  try {
    res = await fetch(url, { headers: headers() });
  } catch (err) {
    throw new Error(
      `accuracy-evaluation: GET ${url} failed (${err instanceof Error ? err.message : String(err)}) — is the server up?`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `accuracy-evaluation: GET ${url} returned ${res.status} — cannot resolve workspace "${WORKSPACE_NAME}"`,
    );
  }
  const list = (await res.json()) as Array<{
    id?: string;
    name?: string;
    config?: string;
  }>;
  const match = list.find((w) => w?.name === WORKSPACE_NAME);
  if (!match?.id) {
    const available =
      list.map((w) => w?.name).filter(Boolean).join(", ") || "none";
    throw new Error(
      `accuracy-evaluation: workspace "${WORKSPACE_NAME}" not found (available: ${available}). ` +
        `Set ACCURACY_EVALUATION_WORKSPACE_NAME or seed the workspace.`,
    );
  }
  _workspaceId = match.id;
  // Capture the deployment the agent actually uses so the quota probe gates on
  // the right bucket. config is an opaque JSON string (validated server-side);
  // a parse failure leaves _workspaceDeployment empty → probe falls back to env.
  try {
    const cfg = match.config ? JSON.parse(match.config) : undefined;
    const dep = cfg?.provider?.azureDeployment;
    if (typeof dep === "string" && dep) _workspaceDeployment = dep;
  } catch {
    /* leave empty → probeAzureQuota falls back to AZURE_OPENAI_DEPLOYMENT_ID */
  }
  return _workspaceId;
}

/**
 * Resolve ANY workspace id by name WITHOUT mutating the module global. Returns
 * null when absent (so a caller can skip gracefully — e.g. the Data Readiness Hub block
 * skips when Data Readiness Hub isn't configured and the workspace doesn't exist).
 * Use for multi-workspace scenarios; the single-workspace path stays on
 * resolveWorkspaceId()/getWorkspaceId().
 */
export async function resolveWorkspaceIdByName(
  name: string,
): Promise<string | null> {
  const url = `${BASE_URL}/api/v1/workspaces`;
  let res: Response;
  try {
    res = await fetch(url, { headers: headers() });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const list = (await res.json()) as Array<{ id?: string; name?: string }>;
  return list.find((w) => w?.name === name)?.id ?? null;
}

/**
 * Does this workspace have a usable tool surface — at least one MCP connection
 * that is reachable AND exposing tools?
 *
 * Product-agnostic on purpose, so RPI and Data Readiness Hub share one gate.
 *
 * The DRH accuracy block used to gate on the WORKSPACE being absent, which
 * stopped being a valid proxy the moment the seed began creating that workspace
 * unconditionally (so a missing DRH_API_URL could no longer delete it). Absence
 * would never happen again, so the scenarios would have run against an
 * unconfigured backend.
 *
 * Read from the server, not this process's environment: the accuracy suite
 * talks to a live server that may hold a different env than the test runner, so
 * a local `process.env` check proves nothing about what that server can reach.
 */
export async function isWorkspaceUsable(workspaceId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE_URL}/api/v1/workspaces/${workspaceId}/runtime-status`,
      { headers: headers() },
    );
    if (!res.ok) return false;
    const status = (await res.json()) as {
      mcp?: Array<{ connected?: boolean; toolCount?: number }>;
    };
    return !!status.mcp?.some((m) => m.connected && (m.toolCount ?? 0) > 0);
  } catch {
    return false;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

/** UI message shape posted to the chat route (matches useChat / chat.ts:60). */
function makeUserMessage(text: string): unknown {
  return {
    id: `accuracy-eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

/** Clear the workspace's trace buffer so each run gets a fresh view. */
async function clearTrace(wsId: string = getWorkspaceId()): Promise<void> {
  const url = `${BASE_URL}/api/v1/workspaces/${wsId}/trace?clear=1`;
  await fetch(url, { headers: headers() }).then((r) => r.json()).catch(() => {});
}

/** Fetch the current trace buffer for the workspace. */
async function fetchTrace(wsId: string = getWorkspaceId()): Promise<TelemetryEvent[]> {
  const url = `${BASE_URL}/api/v1/workspaces/${wsId}/trace`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`trace fetch ${res.status}`);
  return (await res.json()) as TelemetryEvent[];
}

/**
 * Per-run SSE stream statistics — added v1.0.3 to instrument the silent-run
 * class surfaced in the 2026-05-26 full tier (1/40 runs produced zero of
 * everything in the trace buffer). Stream-level stats distinguish "empty
 * stream" from "non-text stream" from "error stream we don't parse" — the
 * three remaining theories after Q1 falsified swallowed-AI-SDK-error.
 */
export interface StreamStats {
  /** Total bytes received from the SSE response body (sum of chunk byteLength). */
  totalBytes: number;
  /** Frame count by AI SDK v6 chunk `type` value. `[DONE]` and `malformed` are sentinel buckets. */
  frameCountsByType: Record<string, number>;
  /** First ~500 raw chars of the decoded stream — verbatim, for inspecting unparseable content. */
  headSnapshot: string;
}

/**
 * Parse a buffer of SSE `data: <json>\n\n` frames; append any text-delta
 * payloads onto `acc`. Returns the new acc + any unconsumed tail of the
 * buffer (a frame split across chunks must be carried into the next read).
 * v1.0.3: also tallies frame counts by type into `stats.frameCountsByType`
 * so empty-stream / non-text-stream / error-frame cases are distinguishable
 * post hoc without re-running.
 */
function consumeSseFrames(
  buffer: string,
  acc: string,
  stats: StreamStats,
): { acc: string; rest: string } {
  let rest = buffer;
  let out = acc;
  while (true) {
    const sep = rest.indexOf("\n\n");
    if (sep < 0) break;
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    // Each frame is one `data: <payload>` line per AI SDK v6 emit.
    if (!frame.startsWith("data:")) continue;
    const payload = frame.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      stats.frameCountsByType["[DONE]"] =
        (stats.frameCountsByType["[DONE]"] || 0) + 1;
      continue;
    }
    try {
      const obj = JSON.parse(payload) as { type?: string; delta?: string };
      const type = obj.type || "unknown";
      stats.frameCountsByType[type] = (stats.frameCountsByType[type] || 0) + 1;
      if (obj.type === "text-delta" && typeof obj.delta === "string") {
        out += obj.delta;
      }
    } catch {
      // Malformed frame — count it as such so silent-run cases surface as
      // `malformed=N` instead of vanishing. Don't poison the run.
      stats.frameCountsByType["malformed"] =
        (stats.frameCountsByType["malformed"] || 0) + 1;
    }
  }
  return { acc: out, rest };
}

/** Drive a single chat turn end-to-end and return the captured trace + parent text + stream stats. */
export async function runPrompt(
  prompt: string,
  opts: { signal?: AbortSignal; workspaceId?: string } = {},
): Promise<{
  traceEvents: TelemetryEvent[];
  durationMs: number;
  parentText: string;
  streamStats: StreamStats;
}> {
  // Target the given workspace, else the suite-resolved global (default path).
  const wsId = opts.workspaceId ?? getWorkspaceId();
  await clearTrace(wsId);

  // Internal AbortController so we can fire `reader.cancel()` on signal abort.
  // The signal alone aborts the fetch but a mid-read `ReadableStreamDefaultReader`
  // won't unblock — explicit cancel is what kills the orphan stream.
  const ac = new AbortController();
  const onAbort = () => ac.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Optional self-imposed timeout (primarily for the cancel-probe).
  const timeoutMs = Number(process.env.ACCURACY_EVALUATION_TIMEOUT_MS || "0");
  let selfTimer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    selfTimer = setTimeout(() => ac.abort(new Error(`self-timeout ${timeoutMs}ms`)), timeoutMs);
  }

  const start = Date.now();
  const url = `${BASE_URL}/api/v1/workspaces/${wsId}/chat`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelOnAbort = () => {
    if (reader) reader.cancel().catch(() => {});
  };
  ac.signal.addEventListener("abort", cancelOnAbort, { once: true });

  let parentText = "";
  const streamStats: StreamStats = {
    totalBytes: 0,
    frameCountsByType: {},
    headSnapshot: "",
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ messages: [makeUserMessage(prompt)] }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`chat POST ${res.status}: ${await res.text()}`);

    reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buf = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamStats.totalBytes += value.byteLength;
        const chunk = decoder.decode(value, { stream: true });
        if (streamStats.headSnapshot.length < 500) {
          streamStats.headSnapshot = (streamStats.headSnapshot + chunk).slice(0, 500);
        }
        buf += chunk;
        const { acc, rest } = consumeSseFrames(buf, parentText, streamStats);
        parentText = acc;
        buf = rest;
      }
      // Flush any partial trailing decoder state. A complete frame must end
      // in `\n\n` so anything still in `buf` after `done` is malformed; ignore.
      decoder.decode();
    }
  } finally {
    if (selfTimer) clearTimeout(selfTimer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    ac.signal.removeEventListener("abort", cancelOnAbort);
  }

  const durationMs = Date.now() - start;

  // Small grace period — onFinish callbacks may emit telemetry just after
  // the SSE stream closes. Empirically <100ms.
  await new Promise((r) => setTimeout(r, 200));
  const traceEvents = await fetchTrace(wsId);
  return { traceEvents, durationMs, parentText, streamStats };
}

// `runPromptWithCancel` removed 2026-05-28. The per-run AbortController +
// arbitrary 100s cancel timer was solving the wrong problem: work is
// already bounded by skill.maxSteps (SKILL.md frontmatter), each LLM
// call's Azure client timeout, and sub-agent `maxRetries: 2` retry-after
// waits. The 100s cap was over-engineering that nearly bit at stress
// (audiences-with-counts-gt-0 p95 = 100.2s touched the ceiling). Callers
// now use `runPrompt(prompt)` directly; the flat 1h bun:test runaway
// timeout (TEST_TIMEOUT_MS) is a safety net, not a gate.

/**
 * v1.1.3 chain-test cache. Stores `{ name }` for the first record of each
 * entity type, populated once via `beforeAll` so each chain scenario can
 * parameterize its prompt with a known-extant name. Workspace-portable —
 * we discover names dynamically rather than hardcoding.
 *
 * Why name-only (not name+id):
 *   - Only `list_clients` surfaces ids in the agent's markdown response.
 *     The other 3 entities surface names + descriptions but not ids.
 *   - Path A assertions (via subAgentToolCalls) can match `rpi__get_*_by_name`
 *     calls that take the name as arg — works for all 4 entities uniformly.
 *   - Agents that go name → id → by_id still pass: subAgentToolCalls will
 *     contain a `rpi__get_*_by_name` (the lookup step) OR a `rpi__get_*_by_id`
 *     with the resolved id; the assertion accepts either via regex.
 *
 * Workspace-empty (zero records) → `name: null` → scenarios skip gracefully.
 */
export type ChainCacheKey =
  | "clients"
  | "audiences"
  | "interactions"
  | "selectionRules";

export interface ChainCacheEntry {
  /** First record's display name, or null if the workspace has no records of this type. */
  name: string | null;
}

const _chainCache: Partial<Record<ChainCacheKey, ChainCacheEntry>> = {};

// ---------------------------------------------------------------------------
// 2026-05-30 — Direct-RPI cache pre-flight (terminal reverse-port Option B).
//
// Replaced the previous markdown-scraping path (runPrompt → agent text →
// `parseFirstRecordName` regex chain). Markdown scraping was implicitly LLM-
// coupled: any LLM swap or sub-agent prompt tweak changed the markdown shape
// silently and could break the parser. Today's `chain-interaction-by-name`
// failure (parser captured trailing colon `"ABC Campaign - Boston Men 6:"`)
// was exactly that failure mode.
//
// Direct-RPI path eliminates the coupling at its source: call RPI's REST API
// via the existing `RPIApiClient` + `searchFileInfos` infrastructure shared
// with `packages/mcp-rpi/src/__tests__/integration/tools-*.integration.test.ts`,
// read structured JSON. Zero markdown, zero LLM coupling, future shape
// changes are caught by typed schema instead of regex drift.
//
// Cross-repo parity: terminal does this via `setupAgent().discoveredTools[
// toolName].execute()`; RP_AI does it via `RPIApiClient` — same architectural
// principle (structured data path), different implementation per existing
// repo infrastructure. Neither repo invents new plumbing.
// ---------------------------------------------------------------------------

let _rpiClient: RPIApiClient | null = null;

function getRPIClient(): RPIApiClient {
  if (_rpiClient) return _rpiClient;
  const required = [
    "RPI_INTEGRATION_API_URL",
    "RPI_OAUTH_CLIENT_ID",
    "RPI_OAUTH_CLIENT_SECRET",
    "RPI_DEFAULT_CLIENT_ID",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `chain cache: RPIApiClient setup missing env vars: ${missing.join(", ")}`,
    );
  }
  const authService = new RPIAuthService(
    process.env.RPI_INTEGRATION_API_URL!,
    process.env.RPI_OAUTH_CLIENT_ID!,
    process.env.RPI_OAUTH_CLIENT_SECRET!,
    process.env.RPI_PROXY_USER,
    process.env.RPI_PROXY_PASS,
  );
  _rpiClient = new RPIApiClient(
    process.env.RPI_INTEGRATION_API_URL!,
    authService,
    process.env.RPI_DEFAULT_CLIENT_ID!,
  );
  return _rpiClient;
}

const FILE_TYPE_BY_KEY: Record<
  Exclude<ChainCacheKey, "clients">,
  string
> = {
  audiences: "Audience",
  interactions: "Interaction",
  selectionRules: "Selection Rule",
};

/**
 * Fetch the first {id, name} record for a cacheKey directly from RPI.
 * Returns `null` if zero records of that type exist (workspace-empty path).
 */
async function fetchFirstRecord(
  key: ChainCacheKey,
): Promise<ChainCacheEntry> {
  const apiClient = getRPIClient();
  if (key === "clients") {
    const res = await apiClient.get<{
      clients?: Array<{ id?: string | null; name?: string | null }>;
    }>(undefined, "/cluster/operations/clients");
    const first = (res?.clients ?? []).find(
      (x) => !!x?.id && !!x?.name,
    );
    return { name: first?.name ?? null };
  }
  const res = await searchFileInfos<{
    results?: Array<{ id?: string | null; name?: string | null }>;
  }>(apiClient, undefined, {
    fileTypes: [FILE_TYPE_BY_KEY[key]],
    pageSize: 5,
  });
  const first = (res?.results ?? []).find(
    (x) => !!x?.id && !!x?.name,
  );
  return { name: first?.name ?? null };
}

/**
 * Build cache entries for the listed keys. Idempotent — already-built keys
 * are skipped on re-call. Hits RPI's REST API directly per cacheKey;
 * structured JSON read instead of markdown scraping (eliminates LLM-coupling
 * drift class observed on 2026-05-30).
 */
export async function buildChainCache(keys: ChainCacheKey[]): Promise<void> {
  for (const key of keys) {
    if (_chainCache[key]) continue;
    _chainCache[key] = await fetchFirstRecord(key);
  }
}

export function getChainCache(key: ChainCacheKey): ChainCacheEntry {
  const v = _chainCache[key];
  if (!v) {
    throw new Error(
      `getChainCache: key=${key} not built; call buildChainCache() in beforeAll`,
    );
  }
  return v;
}

export function clearChainCache(): void {
  for (const k of Object.keys(_chainCache) as ChainCacheKey[]) {
    delete _chainCache[k];
  }
}

/**
 * Extract `subAgentToolCalls` (v1.4 telemetry) from the trace by walking
 * every `execute_skill` tool-result event and flattening their summaries.
 * Returns [] if v1.4 telemetry isn't present (defensive).
 */
export function getSubAgentToolCalls(
  events: TelemetryEvent[],
): Array<{ toolName: string; args: unknown }> {
  const out: Array<{ toolName: string; args: unknown }> = [];
  for (const e of events) {
    if (e.type !== "tool-result" || e.toolName !== "execute_skill") continue;
    const r = e.result as { subAgentToolCalls?: Array<{ toolName: string; args: unknown }> } | undefined;
    if (Array.isArray(r?.subAgentToolCalls)) {
      out.push(...r.subAgentToolCalls);
    }
  }
  return out;
}

/**
 * ORCHESTRATOR-level tool calls — the parent's own `tool-call` events (e.g.
 * render_view_dashboard, render_chart, set_active_tenant), NOT skill dispatches or
 * sub-agent calls. Phase 2 (#27957) moved dashboards from skill routing to the
 * deterministic render_view_dashboard tool, which the parent calls directly — this
 * lets a scenario assert that routing DECISION (the right tool + its viewId) where
 * the skill-based path (getRoutedSkill/subAgentToolCalls) sees nothing.
 */
export function getOrchestratorToolCalls(
  events: TelemetryEvent[],
): Array<{ toolName: string; args: unknown }> {
  const out: Array<{ toolName: string; args: unknown }> = [];
  for (const e of events) {
    if (e.type === "tool-call" && e.toolName) {
      out.push({ toolName: e.toolName, args: (e as { args?: unknown }).args });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Item 4 — probe-paced quota gate (2026-05-28 reverse-port from terminal,
// direct-Azure Path 2). Self-tunes per-deployment via Azure's response
// headers (`x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`,
// `x-ratelimit-reset-tokens`, `retry-after`). RP_AI's chat route doesn't
// propagate these headers, so we hit Azure directly with a 1-token completion
// and read the headers off that response — no server-route change needed.
//
// All magic constants are env-tunable (the "no magic numbers" discipline +
// a catch on the hardcoded gpt-4o / api-version on terminal's first
// pass; we ship parameterized from the start, no follow-up retrofit needed).
// ---------------------------------------------------------------------------

interface AzureQuota {
  limitTokens: number | null;
  remainingTokens: number | null;
  resetTokensSeconds: number;
  retryAfter: number;
}

const PROBE_FETCH_TIMEOUT_MS = Number(
  process.env.ACCURACY_EVALUATION_PROBE_FETCH_TIMEOUT_MS || 10_000,
);
const PROBE_TOTAL_CAP_MS = Number(
  process.env.ACCURACY_EVALUATION_PROBE_TOTAL_CAP_MS || 5 * 60 * 1000,
);
const PROBE_SLEEP_MARGIN_S = Number(
  process.env.ACCURACY_EVALUATION_PROBE_SLEEP_MARGIN_S || 2,
);
const PROBE_SLEEP_CAP_MS = Number(
  process.env.ACCURACY_EVALUATION_PROBE_SLEEP_CAP_MS || 60_000,
);

function numOrNull(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDurationSeconds(s: string | null): number | null {
  if (!s) return null;
  // Azure sometimes returns "5", sometimes "5s" — strip trailing letters.
  const trimmed = s.replace(/[a-zA-Z]+$/, "");
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Probe Azure for current rate-limit state. Returns null if any required
 * env var is missing OR the probe fails / times out — caller treats null as
 * "telemetry unavailable, proceed without gating."
 */
export async function probeAzureQuota(): Promise<AzureQuota | null> {
  // 2026-05-29 cross-repo env-var convergence (terminal reverse-port verdict):
  // both terminal and RP_AI now read the same four AZURE_OPENAI_* names.
  // Earlier shipped names (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION)
  // did not match RP_AI's actual `.env`, which made every gate short-
  // circuit silently. Build the URL from RESOURCE_NAME instead of taking
  // a full ENDPOINT URL — matches terminal's helper shape exactly.
  const resourceName = process.env.AZURE_OPENAI_RESOURCE_NAME;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  // Prefer the resolved workspace's deployment (the agent's actual source of
  // truth) so the probe gates on the matching bucket; fall back to the env var
  // when the workspace hasn't been resolved (e.g. probe called standalone).
  const deployment =
    _workspaceDeployment || process.env.AZURE_OPENAI_DEPLOYMENT_ID;
  const apiVersion =
    process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-01-preview";
  if (!resourceName || !apiKey || !deployment) return null;

  const probeUrl =
    `https://${resourceName}.openai.azure.com/openai/deployments/` +
    `${encodeURIComponent(deployment)}/chat/completions` +
    `?api-version=${encodeURIComponent(apiVersion)}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(probeUrl, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: ac.signal,
    });
    // Headers populate even on 429 — we want them either way.
    return {
      limitTokens: numOrNull(res.headers.get("x-ratelimit-limit-tokens")),
      remainingTokens: numOrNull(
        res.headers.get("x-ratelimit-remaining-tokens"),
      ),
      resetTokensSeconds:
        parseDurationSeconds(res.headers.get("x-ratelimit-reset-tokens")) ?? 0,
      retryAfter: numOrNull(res.headers.get("retry-after")) ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until Azure's available-tokens fraction is at least GATE_PCT AND the
 * reset window is essentially done. Bounded by `PROBE_TOTAL_CAP_MS` — beyond
 * that, log and proceed (don't fail the test on a stuck gate, just lift the
 * pacing). Silently skipped when `ACCURACY_EVALUATION_PROBE_PACE=FALSE` OR
 * the probe returns null (missing Azure env / non-Azure deployment).
 */
export async function waitForQuotaGate(label: string): Promise<void> {
  if (process.env.ACCURACY_EVALUATION_PROBE_PACE === "FALSE") return;
  const gatePct = Number(process.env.ACCURACY_EVALUATION_GATE_PCT ?? "0.9");
  const start = Date.now();

  while (Date.now() - start < PROBE_TOTAL_CAP_MS) {
    const q = await probeAzureQuota();
    if (!q || q.limitTokens == null || q.remainingTokens == null) {
      console.log(
        `[probe-pace ${label}] probe unavailable (env missing or non-Azure response); skipping gate`,
      );
      return;
    }
    const pct = q.remainingTokens / q.limitTokens;
    const resetReady =
      gatePct >= 1.0 ? q.resetTokensSeconds === 0 : q.resetTokensSeconds <= 5;
    if (pct >= gatePct && resetReady) {
      console.log(
        `[probe-pace ${label}] OK · cap=${q.limitTokens} rem=${q.remainingTokens} ` +
          `(${(pct * 100).toFixed(0)}%) reset=${q.resetTokensSeconds}s`,
      );
      return;
    }
    const sleepMs = Math.min(
      Math.max(
        q.retryAfter,
        q.resetTokensSeconds + PROBE_SLEEP_MARGIN_S,
      ) * 1000,
      PROBE_SLEEP_CAP_MS,
    );
    console.log(
      `[probe-pace ${label}] WAIT · cap=${q.limitTokens} rem=${q.remainingTokens} ` +
        `(${(pct * 100).toFixed(0)}%) reset=${q.resetTokensSeconds}s · sleeping ${sleepMs}ms`,
    );
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  console.log(
    `[probe-pace ${label}] total-cap ${PROBE_TOTAL_CAP_MS / 1000}s hit; proceeding regardless`,
  );
}

/**
 * Run a scenario N times; collect pass/fail per the scorer fn.
 *
 * Per-iteration error trap (2026-05-28 terminal reverse-port): if `fn()` throws,
 * the caller's `failFactory(err, idx)` produces a failed-shape result and
 * iteration continues. Without it, one timeout / 429-after-retries kills
 * every remaining iteration. With it, errors count as fails and the
 * scenario sees the full N runs.
 *
 * Probe-paced quota gate (Item 4): before each iteration, await
 * `waitForQuotaGate(label)`. No-op when probe-pace is disabled or Azure env
 * is unavailable; otherwise blocks until bucket has GATE_PCT capacity.
 *
 * `failFactory` is optional for backward compat — callers without one get
 * the legacy throw-on-error behavior.
 */
export async function runN<T extends { passed: boolean }>(
  n: number,
  fn: () => Promise<T>,
  failFactory?: (err: unknown, idx: number) => T,
  label = "runN",
): Promise<{
  results: T[];
  passRate: number;
  latencies: number[];
  errors: Array<{ idx: number; err: unknown }>;
}> {
  const results: T[] = [];
  const latencies: number[] = [];
  const errors: Array<{ idx: number; err: unknown }> = [];
  for (let i = 0; i < n; i++) {
    await waitForQuotaGate(`${label}#${i + 1}/${n}`);
    const t0 = Date.now();
    try {
      const r = await fn();
      latencies.push(Date.now() - t0);
      results.push(r);
    } catch (err) {
      latencies.push(Date.now() - t0);
      if (failFactory) {
        errors.push({ idx: i, err });
        results.push(failFactory(err, i));
      } else {
        throw err;
      }
    }
  }
  const passes = results.filter((r) => r.passed).length;
  return { results, passRate: passes / n, latencies, errors };
}

/** First `execute_skill` tool-call in a trace — the routing decision. */
export function getRoutedSkill(events: TelemetryEvent[]): string | null {
  for (const e of events) {
    if (e.type === "tool-call" && e.toolName === "execute_skill") {
      const args = e.args as { skillName?: string } | undefined;
      if (args?.skillName) return args.skillName;
    }
  }
  return null;
}

/** All execute_skill dispatches in a trace (multiple if the agent chained). */
export function getAllDispatches(events: TelemetryEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "tool-call" && e.toolName === "execute_skill") {
      const args = e.args as { skillName?: string } | undefined;
      if (args?.skillName) out.push(args.skillName);
    }
  }
  return out;
}

/** Final assistant text from an execute_skill result (last skill's result). */
export function getFinalText(events: TelemetryEvent[]): string {
  let text = "";
  for (const e of events) {
    if (e.type === "tool-result" && e.toolName === "execute_skill") {
      const r = e.result as { result?: string } | undefined;
      if (r?.result) text = r.result;
    }
  }
  return text;
}

/**
 * Did the agent return a clarifying question (no dispatch + non-empty parent text)?
 * v1 used absence-of-dispatch alone, which green-pased crashes. v1.0.1 also
 * requires `parentText` to be non-empty so a silent/crashed run fails honestly.
 */
export function looksClarifying(
  events: TelemetryEvent[],
  parentText: string,
): boolean {
  if (getAllDispatches(events).length > 0) return false;
  return parentText.trim().length > 0;
}

/** Compute p50 / p95 over a sorted ascending latency array. */
export function percentiles(latencies: number[]): { p50: number; p95: number } {
  if (latencies.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: pick(0.5), p95: pick(0.95) };
}
