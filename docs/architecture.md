# Architecture

## Overview

RedpointAI is a two-layer system. The **MCP layer** wraps RPI's Integration API as standard MCP tools that any client (Claude Desktop, Cursor, or RedpointAI itself) can consume. The **Skill Router layer** groups those tools into domain-specific skills, routing agent requests through a token-efficient catalog instead of exposing all 30+ tools at once.

### Architecture evolution

The system has grown through seven tool- and knowledge-exposure / interop generations (the major version tracks this generation). The first six are established; the seventh — read-surface expansion — is the current generation:

1. **Flat tooling** — every MCP tool exposed at once. Now the Tier-3 fallback only (token-heavy; safety net, not a target).
2. **Categorical tooling** — on-demand category discovery via a single `tools_list` meta-tool (Tier 2). Activates when the MCP server sets the boolean `listTools.supportsFiltering: true` in its initialize handshake (checked by `resolveTier()`); wired but runtime-inactive — the RPI MCP server doesn't set it yet.
3. **Skill routing** — one `execute_skill` meta-tool over a compact skill catalog (~500 tokens vs ~15k to expose every tool flat), dispatching to isolated sub-agents (Tier 1). **The live default path — and, from a token perspective, the most economical (lowest $) of the three tool-exposure tiers: the LLM sees a tiny catalog instead of the full tool surface on every turn.**
4. **A2A** — inbound agent-to-agent server (JSON-RPC 2.0 + public agent card) so other agents can call this one. Off by default; enable by setting the boolean `A2A_ENABLED=true` (with `A2A_WORKSPACE_ID` + `A2A_BEARER_TOKEN`).
5. **RPI expert** (grounded dispatched knowledge) — a tool-less domain expert (`dispatch: true`) dispatched on knowledge intent via `execute_skill`, answering **strictly from a curated body** (grounded: it refuses rather than inventing from training knowledge for anything the body does not cover). A new *knowledge*-exposure shape, distinct from inlined experts (always-on, in-prompt) and from action dispatch (tools): the curated knowledge loads into a sub-agent only when a domain question hits it, so depth costs the parent prompt nothing. Currently `rpi-domain-expert`, with an SME-authored curated body; the grounding contract itself is not hand-written into the skill file but injected at dispatch from the shared `GROUNDING_PREAMBLE` (see [Multiple knowledge experts & the shared grounding contract](#multiple-knowledge-experts--the-shared-grounding-contract)).

6. **DRH expert** (multi-domain platform) — more than one product domain (e.g. RPI and Data Readiness Hub), each isolated in its **own workspace** with its own MCP server connection and skill set (WHAT experts + HOW action skills), all riding the **single shared LLM orchestration/dispatch chokepoint** (chat route → orchestrator → `router.ts` `execute_skill`) — no forked LLM path per domain, so instrumentation wraps one point (see the instrumentation feature under [Cross-cutting subsystems](#cross-cutting-subsystems)). Domains are chosen via the landing-page workspace picker (shown when more than one workspace exists). Per-workspace `config.mcp` + `config.skills` keep tools and knowledge isolated across domains (a turn in one workspace can't reach another's tools). Data Readiness Hub is the first sibling to RPI: `packages/mcp-drh` is a real standalone MCP server (OpenAPI-typed client + Keycloak-signon auth + incoming-auth middleware) exposing the full Data Readiness Hub tool surface, with live connectivity verified end-to-end. Its per-call scope is **configured deployment context injected server-side, not derived from the prompt**: the tenant `X-ClientId` from `DRH_DEFAULT_CLIENT_ID`, and the `databaseId` from `DRH_DEFAULT_DATABASE_ID` (a tenant can hold more than one database and there is no runtime picker, so the deployment selects it). The Data Readiness Hub workspace is seeded unconditionally, but its card renders only when `DRH_API_URL` is set — the workspace-list endpoint filters it out otherwise (read-path only: the row and its threads are never touched, and the card returns intact when the key returns). RPI-only installs see only the RPI card; a partially configured DRH (URL set, other keys missing) still renders with the standard missing-key diagnostics. Its 93-tool surface is live end-to-end (read-only by default on the standalone server: the 36 `MUTATING`/`DESTRUCTIVE` tools are gated, 57 exposed — see [Read-only enforcement](#read-only-enforcement-standalone-servers)). The curated domain corpus is still pending (SME), so the domain expert returns an explicit "knowledge base not yet curated" response until it lands.

7. **Read-surface expansion** — a curated GET-tool superset compiled into the MCP server (superset-at-build), masked at runtime against the running instance's OpenAPI spec (mask-at-runtime): at boot the server fetches the instance spec and `.disable()`s any tool the instance doesn't serve (fail-open if the spec is unreachable), so one binary fits any instance version. The **same boot fetch** also drives a coarse **MAJOR.MINOR version-compatibility gate** — the instance's reported API version is compared against the version the tool surface was built against, yielding a `match` / `mismatch` / `unknown` status surfaced softly on the server's health endpoint. It is **fail-open**: a mismatch or an unreadable version never blocks startup (the mask already trims any drifted surface); it is an operability signal that a server and an instance are on different API versions. It expands the RPI read surface from the hand-written tools to **197 exposed read tools** (44 hand reads + 153 generated; 49 hand-written tools registered, of which 5 mutating tools are gated), authored domain-by-domain from an `operationId`-keyed overlay (hand-written, DRH-quality descriptions) with a mutation-verb guard that excludes action-shaped GETs (a GET whose endpoint mutates state). The 185 in-scope GETs are fully accounted at build time — **153 authored + 29 hand-covered + 3 suppressed (functional duplicates of hand tools) + 0 awaiting** — a tripwire the generator prints on every run. Additive by construction — every generated tool is read-only and endpoint-stamped, and the orchestrator/skills are untouched, so a retail MCP client sees the expanded surface directly via `tools/list` while our own orchestration adopts tools deliberately.

Details for the tool-exposure tiers are in [Tool-exposure tiers](#tool-exposure-tiers-graceful-degradation); A2A lives in `apps/server/src/a2a/`; the dispatched-knowledge shape is in [Layer 2](#layer-2-skill-router-agent-orchestration).


### Configuration ownership

Not a generation — a property that holds across all seven. **Workspace config comes from code plus the
environment, and the seed owns it** — `apps/server/src/store/seed.ts` and the environment (`.env` for
OSS, key vault when hosted), and nowhere else. The seed is *authoritative*: it rewrites the seeded workspaces' config on **every boot**, preserving nothing — `provider` included, since `pickDefaultProvider()` derives it from the environment and a stored copy would pin a workspace to a provider whose key has since been removed. The consequence is that changing a model or provider is an `.env` edit plus a restart, not an API call. Two properties follow. (a) **The workspace set is enforced**: after seeding, anything outside the seeded products is removed and same-name duplicates collapse to the oldest row — but never at the cost of history, since `threads` cascade, so a row that cannot be reparented is left in place instead of deleted. (b) **Secrets never enter the database**: `provider.apiKey` accepts only `${ENV_VAR}` indirection, so a literal key cannot be stored where it would sit in plaintext SQLite and silently shadow the configured environment. There is deliberately no UI for editing any of this.

### Environment configuration: one source, three derived artifacts

There is a single environment source of truth — the root `.env`, organized into `#@scope:` blocks that tag each variable with the artifacts that consume it (`hosted-app`, `mcp-rpi`, `mcp-drh`, `container`). `scripts/env-scopes.ts` derives every shipped env artifact from those tags, so no parallel list is hand-maintained:

- **(a) the committed `.env.example`** — the full superset: every key, documented, secret values empty and hosts genericized (the deployer/OSS-reader template).
- **(b) the per-binary templates** — a *minimal subset*: each standalone MCP-server zip carries only the keys that server reads (least privilege; cross-scope keys are absent by construction).
- **(c) the docker bundle** — the *full superset*. The bundle build bakes the real root `.env` verbatim, and the compose loads it into **every** service via `env_file`. The compose `environment:` blocks then apply **only container VALUE-OVERRIDES** — the handful of values that must differ inside the compose network (reach a peer by its service name instead of localhost, container ports, container filesystem paths). Auth is not special-cased: `AUTH_REQUIRED` comes from `.env` (auth=true), exactly like the web app.

The rule the container follows — **the container gets the full superset via `env_file`; compose overrides values only, and hides no key** — is enforced by `check:env`, which fails the build if the compose sets a key that is neither in the superset nor a documented override, or hardcodes a superset key (e.g. re-pinning `AUTH_REQUIRED`) instead of taking it from `.env`. This is a guard against a real failure mode: a compose that hardcodes a value (historically `AUTH_REQUIRED=false`) silently diverges the container from the app and from the source of truth. A related self-heal lives in the seed: the schema bootstrap probes **every** expected table (not just one) and runs an additive `drizzle-kit push` when any is missing, so a persistent volume carried across an upgrade gains new tables without losing existing data.

## System Diagram

```
Frontend (Next.js)
  |  useChat / AG-UI (SSE)
  v
Backend (Bun + Hono)
  |-- Workspace Manager     — reads seeded workspace configs (see #7)
  |-- Agent Orchestrator     — AI SDK streamText/generateText
  |-- Skill Router           — execute_skill meta-tool
  |-- Conversation Store     — threads, messages, runs
  |
  v
MCP Client --> RPI MCP Server --> RPI Instance
```

## Monorepo Structure

| Package | Purpose |
|---------|---------|
| `apps/server` | Hono API server — routes, agent orchestration, MCP client, auth, metrics |
| `apps/web` | Next.js frontend — chat UI, workspace management, provider selection |
| `packages/shared` | Zod schemas, TypeScript types shared across packages |
| `packages/skills` | Skill runtime — loader (parses SKILL.md), registry, router tool |
| `packages/mcp-rpi` | Standalone MCP server wrapping RPI's Integration API (49 tools across 8 domains: admin, audiences, auth, clients, file-system, folders, interactions, selection-rules; **read-only by default — 5 write tools gated, 44 exposed**, see [Read-only enforcement](#read-only-enforcement-standalone-servers)) |
| `packages/mcp-drh` | Standalone MCP server wrapping Data Readiness Hub's OP-Services API (93 tools across 11 groups: aggs, auth, automation-logs, data-qualities, databases, feeds, runs, schedules, sources, subject-areas, ui-dashboard; **read-only by default — 36 write tools gated, 57 exposed**); Keycloak-signon auth, server-side `X-ClientId` + `databaseId` scoping |
| `skills/` | Skill definitions — SKILL.md files organized by type |

## Data Flow

1. User sends a message in the chat UI
2. Frontend's `useChat` hook POSTs to `/api/v1/workspaces/:id/chat`
3. Backend loads the workspace config (provider, system prompt, MCP connections, skills)
4. Skills are filtered by the workspace's `config.skills` array (via `registry.filterByNames()`)
5. Agent Orchestrator builds the model and tool set
6. Inlined experts (e.g. the foundation expert) are folded into the system prompt as "Domain Knowledge"; dispatched experts (`dispatch: true`) instead join the catalog as tool-less `(knowledge)` entries
7. If any dispatchable skills exist (action/hybrid **or** dispatched experts), the router exposes an `execute_skill` meta-tool with a compact catalog
8. Foundation-level questions answer inline; deeper domain-knowledge questions dispatch via `execute_skill` to the dispatched knowledge expert, which answers strictly from its curated body (or refuses if unauthored)
9. For action requests, the agent calls `execute_skill("rpi-interactions", "list my interactions")`
10. A sub-agent spawns with only that skill's MCP tools and domain instructions (a dispatched expert's sub-agent gets no tools)
11. Sub-agent calls MCP tools, which hit the RPI Integration API
12. Results flow back through the sub-agent to the router to the user

## Two-Layer Architecture

### Layer 1: MCP Server (tool exposure)

The RPI MCP server is a standalone process exposing RPI capabilities via the Model Context Protocol. It supports both stdio (for Claude Desktop) and HTTP (the default transport). Any MCP client can connect independently of RedpointAI.

#### Read-only enforcement (standalone servers)

Both MCP servers ship a **read-only tool surface by default**. The standalone binaries expose the raw registered tools to *any* MCP client — no skill router, no `mcpToolFilter`, so the orchestrator's read-only posture (Layer 2) does not reach them, and the auth middleware gates *presence*, not per-tool intent. To close that gap, each server factory (`createRPIMcpServer`, `createDrhMcpServer`) runs an unconditional registration-time sweep that **disables every tool annotated `readOnlyHint: false`** via the SDK's `RegisteredTool.disable()`. A disabled tool is absent from `tools/list` **and** rejected on `tools/call` (`Tool <name> disabled`) — a list-only filter (`tool-filter.ts`) would have left it callable, so the gate uses the SDK `enabled` flag, which blocks both. Net exposed surface: **RPI 44 of 49** (5 writes gated), **Data Readiness Hub 57 of 93** (all `MUTATING` + `DESTRUCTIVE` tools gated).

Three properties keep it safe and maintainable:

- **Fail-closed by annotation, not a name denylist** — any write tool added later is gated automatically; the `readOnlyHint` each tool already declares *is* the contract, so a new mutating tool can't ship un-gated by omission.
- **No env toggle** — the sweep is hardcoded, not switchable. The binaries ship with an operator-edited `.env`, so a `READ_ONLY`-style flag would hand the bypass to exactly the population it closes; the control is the rebuild, and no such key appears in any shipped `.env`.
- **Reversible in-repo, no upstream dependency** — a small `WRITE_TOOLS_ALLOWED` constant re-enables specific tools by name (RPI keeps the selection-rule `count`/`waterfall` job tools as accepted risk; DRH's list is empty). The tool stays fully registered, so re-enabling is one array entry plus a rebuild — no RPI/DRH-side knowledge required.

### Layer 2: Skill Router (agent orchestration)

For RedpointAI's own agent, MCP tools are grouped into skills. Expert (knowledge-only) skills come in two shapes:

- **Inlined experts** (default) are folded directly into the system prompt as "Domain Knowledge" sections — used for cross-cutting, always-on guidance (e.g. the foundation expert: client/tenant ID, terminology, error conventions). Cheap to read, but every inlined body taxes *every* request.
- **Dispatched experts** (`dispatch: true`, e.g. `rpi-domain-expert`) are knowledge-only but **not** inlined — they appear in the catalog as a tool-less `(knowledge)` entry and are reached via `execute_skill`, so a deep curated body loads into a sub-agent **only on a knowledge-intent hit** and costs the parent prompt nothing. Every dispatched expert runs under a shared grounding contract (injected at dispatch, not hand-written per file): it answers strictly from its curated body and refuses (rather than inventing from training knowledge) for anything that body does not cover.

Action and hybrid skills appear in the same compact catalog (~500 tokens) reached through one `execute_skill` meta-tool, instead of 30+ individual tool schemas (~15k tokens). Each action/hybrid/dispatched-expert invocation spawns an isolated sub-agent — action/hybrid sub-agents get the relevant tools; a dispatched expert's sub-agent gets none (knowledge only).

**Why both?** MCP provides standard interop. The skill router provides token efficiency and domain isolation, which are critical given RPI's large API surface.

### Tool-exposure tiers (graceful degradation)

The agent always tries to expose **as few tools as possible** to the LLM. Tiers, in priority order:

1. **Tier 1 — Skill router (best)**: ONE tool exposed (`execute_skill`). The router LLM picks a skill by name; an isolated sub-agent runs with that skill's instructions and tools. Used when the workspace has any action/hybrid skills configured. Within a sub-agent: if the skill's `mcpToolFilter` is **absent**, the sub-agent gets ALL discovered MCP tools at runtime (dynamic discovery — survives upstream tool churn). If `mcpToolFilter` is **present**, it acts as opt-in scoping for security/focus/multi-server isolation.

   **Operation-class narrowing (Pattern A):** a heavy skill may also declare an `operations:` map in its SKILL.md frontmatter (e.g. `list`, `get`, `count`, `metadata`, `workflow`), each mapping to a narrower tool subset. When the router passes an `operation` to `execute_skill(skill, input, operation?)`, the sub-agent receives that subset instead of the full `mcpToolFilter`, shrinking the sub-agent prompt (~10K → 2-4K tokens on common list/get prompts). A missing or unknown operation falls back to `mcpToolFilter` — safe by design. Live on `rpi-audiences`, `rpi-interactions`, `rpi-selection-rules`, and `rpi-attributes` — the first domain skill adopted from the generation-7 read-surface expansion, whose generated tools reach the orchestrator via new domain skills adopted one at a time, each eval-gated (schema in `packages/skills/src/skill.ts`).

   **Routing on intent, not the surface verb (Guideline #11):** the operation is chosen from what the request *wants*, not its leading word. A count predicate — "list rules **with counts > 0**", "non-zero", "size > N" — is a COUNT intent → `operation:"count"`, even though the verb is "list" (routing it to `list` strips the count tool and the sub-agent can't deliver). Counts are per-rule jobs (no bulk-count endpoint), so the `count` path **counts at most the first ~10 rows in list order, then stops** — a hard per-turn cap that bounds what would otherwise be a ~9-minute grind on a 242-rule set. Results are reported scoped to "the first N of M matching" (ask about a specific rule for its detail); the response never claims completeness about the un-counted rows.
2. **Tier 2 — Category discovery (mid)**: ONE tool exposed (`tools_list`). The LLM browses categories on demand and pulls just the schemas it needs. Used when the workspace has no actionable skills but the connected MCP server advertises `supportsFiltering`. Tier selection is wired into the chat route via `resolveTier()` (`apps/server/src/agents/tier-resolver.ts`, called in `routes/chat.ts`); this tier activates only when **every** connected MCP server advertises `supportsFiltering`, which the RPI MCP server does not yet — so it is wired but runtime-inactive today.
3. **Tier 3 — Flat (fallback)**: All discovered MCP tools exposed at once. Used only when neither skills nor server-side filtering are available. This is the worst case for token efficiency and tool-selection accuracy and is meant as a safety net, not a target state.

**Authoring rule for skill bodies**: Skill prose (the SKILL.md body) must NEVER name specific MCP tools. Tool descriptions live in the MCP server's tool source and are discovered at runtime; skill bodies prime *domain knowledge* (entities, vocabulary, patterns), nothing else. This keeps skills resilient when the upstream tool surface changes and lets the same prose body be lifted across agent runtimes (e.g., the terminal agent) where the wiring layer differs.

### Multiple knowledge experts & the shared grounding contract

Dispatched experts scale to multiple domains (e.g. an RPI expert alongside a separate domain expert) without cross-contamination, on three decisions:

- **One grounding contract, shared — not hand-copied per file.** Every dispatched expert answers under the same hardened rule: answer strictly from its curated body; refuse (rather than invent from training knowledge) when a topic is uncovered; never extrapolate to an *adjacent* uncovered topic; answer multi-part questions part-by-part. That contract is factored into a single **domain-agnostic** constant — `GROUNDING_PREAMBLE` in `packages/skills/src/grounding-preamble.ts` — prepended to an expert's curated body when its sub-agent is dispatched. It lives in one place so every present and future expert inherits the identical hardened rule; a grounding fix lands once, not once-per-expert-file (which would drift). The constant names no domain — each expert's own SKILL.md intro establishes identity; the preamble supplies only the rules.
- **Isolation is per-workspace, not per-catalog.** `buildRouterSystemPrompt()` builds each workspace's catalog from that workspace's own `config.skills` allowlist. Two knowledge experts live in **separate workspaces** and never appear in the same catalog, so choosing a domain is a workspace selection (the landing page picks the workspace + its MCP server), not an in-prompt disambiguation problem. A workspace's catalog only ever contains its own domain's `(knowledge)` entry — the routing guideline stays singular and correct per-workspace, with no N-expert selection rule needed.
- **Shared plumbing is code, never navigable content.** Dispatched experts and their sub-agents are tool-less and never touch the filesystem; the loader reads each `SKILL.md` body verbatim (no include/transclusion mechanism exists). Anything shared across experts is therefore TypeScript in `packages/skills/src/` that the router assembles into the prompt *string* at dispatch time (the same pattern as `cachingOptions`) — there is deliberately no "shared SKILL.md" file or include directive for skill bodies.

## Cross-cutting subsystems

The following were ported from the v3 terminal agent and now live in `apps/server`:

- **Provider-aware schema middleware** (`apps/server/src/config/schema-middleware.ts`) — wraps every LLM model to strip JSON-Schema fields that specific providers reject (Anthropic strictness, Azure quirks). Applied at model construction in `createModelFromConfig()` so every tool schema flowing to any provider is cleaned automatically.

- **Deterministic + bounded + resilient LLM calls** — three settings applied at every parent (`orchestrator.ts`) and sub-agent (`router.ts`) call site, plus the Azure provider's `fetch`: (a) **`temperature: 0`** — skill/operation routing must be reproducible; the default ~1.0 made the same prompt route differently run-to-run (and the accuracy eval wobble). (b) **`maxOutputTokens` bounds** (parent 2000 / sub-agent 3000) — Azure's per-call TPM *admission estimate* is `prompt + maxOutputTokens`, so an unbounded call is charged the model max (~16K) and 429s on a tight bucket even though real output is ~200 tokens. (c) **Reactive retry-after fetch wrapper** (`apps/server/src/config/retry-fetch.ts`, wired via `createRetryAfterFetch()` into `createAzure({ fetch })`) — on a 429 it waits the deployment's *real* `retry-after` and refires, ignoring Azure's misleading `retry-after-ms: 0` (which the SDK's built-in retry follows and fast-fails on). Bounded by a 75s total budget. NB: each Azure **deployment id is its own TPM bucket**, so routing a workspace at a less-contended deployment (e.g. `gpt-4.1`'s 100K vs a shared `gpt-4o`'s 10K) is a config change, not a model downgrade — see `docs/providers.md`.

- **Patched MCP transport** (`apps/server/src/mcp/patched-transport.ts`) — custom HTTP transport for `MCPClientManager` with two jobs: (a) compat patches (`protocolVersion`, `serverInfo`) for non-spec-compliant MCP servers, and (b) capturing `serverCapabilities` from the initialize response so downstream code can tell whether a server supports category filtering. It also fixes one end of a **timeout invariant that spans three layers**: a long-running tool must abort *before* the transport gives up, which must abort before Bun closes the socket — `tool 220s < transport 240s < Bun idleTimeout 255s`. Violate it in the middle and a long poll dies transport-aborted rather than returning a clean tool timeout, which reads as a hang. Any tool that polls (audience and interaction workflow runs) therefore caps its own budget at 220s, and the value is restated at each constant because the claim had previously spread into `describe()` strings and SKILL.md prose, where a stale copy reaches live LLM input.

- **Loud degradation on an unavailable MCP server** — `getToolsForWorkspace()` is never awaited unguarded. The chat, AG-UI and workspace-tools routes each race it against a 10s fuse and, on failure, return an explicit `mcp_unavailable` 503 rather than continuing with an empty tool map. The choice is deliberate: an agent that looks healthy but silently has no tools is worse than an error, so loud-but-wrong beats quiet-and-wrong. The landing page's per-workspace status line (see the `runtime-status` enum above) is the read-only counterpart — it names the failure before a user ever opens a chat.

- **MCP category discovery** (`apps/server/src/mcp/mcp-category-discovery.ts`) — when a connected MCP server advertises `supportsFiltering` with `availableCategories`, this module synthesizes a `tools_list` meta-tool so the agent discovers tools by category on demand instead of being handed every tool schema upfront. Tier selection is wired (`resolveTier()` in the chat route); this path stays runtime-inactive until the RPI MCP server enables filtering.

- **Hallucination detection** (`apps/server/src/agents/hallucination-detector.ts`) — `onStepFinish` callback in the chat route. Detects cases where the model asserts an action completed (e.g., "stored successfully") without having called `execute_skill`. Logs an audit event and increments the `hallucinationsTotal` Prometheus counter. Detection-only; no mid-stream retry (would double latency for a minority case).

- **A2A inbound server** (`apps/server/src/a2a/`) — JSON-RPC 2.0 Agent-to-Agent protocol server, feature-flagged via `A2A_ENABLED`. Exposes an Agent Card at `/.well-known/agent-card.json` and a JSON-RPC endpoint at `/` (Bearer auth). Lets other agents call this agent over HTTP. Lives on a separate port (`A2A_PORT`, default 4100), bootstrapped from `apps/server/src/index.ts` only when enabled.

- **Provider-agnostic prompt caching** (`packages/skills/src/caching-options.ts`) — single `cachingOptions` constant passed as `providerOptions` at every `streamText` / `generateText` / `ToolLoopAgent` call site (orchestrator, agui route, skill router sub-agent). The Vercel AI SDK silently drops keys for inactive providers, so one constant covers Anthropic (~90% off cached prefixes via explicit `cacheControl`) and OpenAI/Azure (~50% off >1024-token prefixes via `promptCacheRetention: '24h'`) with zero branching. Verified via `tokens.cached` / `tokens.cacheCreated` fields on the `TelemetryEvent.tokens` shape — populated from `usage.inputTokenDetails` and surfaced inline in step-finish messages so traffic exports show binary "is it firing?" verification (turn-2 should have `cached:N`).

- **Economic-viability instrumentation** (`packages/shared/src/instrumentation.ts` pure spine + `apps/server/src/instrumentation/` host sink) — a rough internal cost probe, **off by default** (gated by `INSTRUMENTATION_ENABLED`; the flag is checked *before* any per-call overhead and *before* any write, so a clone that never opts in runs fully inert). When on, it captures per-call model and **token counts** (the vendor's own per-call numbers — input, cache-read, cache-write, output, reasoning, total — nothing estimated) at the single shared orchestration chokepoint — the rep-facing web chat parent turn plus its `execute_skill` sub-agents, correlated by `requestId` so a routed turn's full dispatch-tree is captured rather than under-counted at the parent. It captures **rep-driven web traffic only** (the A2A and AG-UI front doors are deliberately not instrumented — they aren't internal-cost paths). **No dollars are computed and no pricing ships** — turning tokens into money is the operator's own downstream step with their own rate card (the offline report, `scripts/instrumentation-report.ts`, prints the token breakdown incl. a `net = total − cached` column, never a cost). Events append to a local `.jsonl` sink; hand-collecting a few operators' files is the **complete deliverable** — a rough internal read on usage, with no further phase and no central pipeline planned.

- **Web build-version surface** (`packages/shared/version.json` → `apps/web/lib/version.ts` → `apps/web/components/chat/info-panel.tsx` Config-tab Row) — a committed `{ "version": "…" }` inlined into the client bundle at build (static import, not a runtime read). The value is a **manually-stamped `MAJOR.MINOR`** string — MAJOR tracks the architecture generation (the seven above; currently 7 = read-surface expansion), MINOR is a per-cycle counter bumped each merge cycle (reset to 0 when MAJOR advances). Automatic derivation (from a release tag / commit SHA) is deferred to the publish pipeline. Build-inert: no `.git`/CI needed at build, ships as-is in the zip/image.

- **Traffic-panel trace display** (`apps/web/components/chat/info-panel.tsx` Traffic tab ← the app server's per-workspace trace buffer) — an **ephemeral, in-memory** buffer of `TelemetryEvent`s (`appendTrace`/`getTrace`) streamed to the panel over SSE (`/api/v1/workspaces/:id/trace/stream`). That endpoint sits behind the `/api/v1/*` auth gate, and a browser `EventSource` cannot set an `Authorization` header, so the panel reads it through a **same-origin Next proxy** (`apps/web/app/api/proxy/trace/…`) that injects the session credential via `buildForwardHeaders` and pipes the SSE through **unbuffered** (mirroring the chat proxy). Under `AUTH_REQUIRED=true` this delivers the rich server-side telemetry to the panel instead of 401-ing — a direct EventSource showed only frontend lifecycle events. This display buffer is **separate from** the economic-viability metering sink above: the agent run emits to **both** independently, so a display-read outage never affects capture (the token counts are still recorded server-side; the bug was display-only).

- **Deterministic view-dashboards** (`render_view_dashboard` orchestrator tool + a view registry in `apps/server/src/agents/dashboards/`) — an in-chat dashboard whose layout is assembled entirely in code, never composed by the LLM. Five architecture facts:
  - **The LLM picks intent, code assembles the spec.** The model's only job is to select a `viewId` and extract a small param set (e.g. a date range). `render_view_dashboard`'s `execute()` looks the view up in the registry, calls its `dataSource` (a dumb structured fetch, run under the caller's own RPI auth via the per-request MCP tool map — never the service account when a user is present), runs its **pure** `templateFn` to produce a `DashboardSpec`, re-validates that spec, and **returns it as the tool RESULT**. The tool-UI renders from the result. Composition leaves the model entirely — the same `(data, params)` yields a byte-identical spec.
  - **Registry-entry contract.** A view is `{ id, description, paramsSchema, dataSource(params, ctx), templateFn(data, params) }`. `dataSource` is a dumb fetch (names one tool/endpoint, no logic); `templateFn` is pure assembly (deterministic, no I/O, no LLM, tolerant of an empty/partial response). **Adding a view is one registry entry** — no new tool registration, rendering code, or routing scenario.
  - **Why deterministic (the retired design and its failure mode).** The prior dashboard was **LLM-composed**: the orchestrator built the `DashboardSpec` from a sub-agent's **text** summary, because a ready spec can't cross the sub-agent → orchestrator text boundary. That made multi-panel layout **steering-dependent** and prone to dropped panels (a variance the routing eval couldn't see). Assembling in code removes the boundary and the variance: the only LLM-facing behavior left is `viewId` + param selection (a routing check), so the dashboard **output is not eval-gated**.
  - **Server-side aggregation, zero client grind.** The first view (interaction runs) sources its data from the RPI Integration API's **server-side run-aggregation endpoint** — a `GROUP BY` that returns run counts bucketed by day/week/month and execution mode in one fast call. The client does **no** aggregation. This replaces an earlier interim path that ground a super-linear per-instance endpoint client-side (removed). `templateFn` maps the returned buckets onto the layout: a `columns:5` grid with a full-width stacked bar (`colSpan:5`) over a 60/40 row (test/prod area `colSpan:3` + test-vs-production donut `colSpan:2`) plus a headline tile row (`ChartSpec.colSpan` 1–6, clamped to `columns`, drives the asymmetric grid; expanded content caps at a readable centered width; inline always stacks 1-up).
  - **The single-chart tier stays lenient.** Only dashboard *composition* moved to code. `render_chart` / `render_stats` remain **LLM-args** orchestrator tools for an ad-hoc single chart or KPI row of arbitrary fetched data — the free-composition path for one-off visuals, unchanged.

## Authentication & authorization

**Secure by default.** Auth is *required* unless `AUTH_REQUIRED` is explicitly `false` — an unset value counts as required (both the request-path middleware and the app-server boot guard treat anything other than `"false"` as auth-required), and `.env.example` ships `AUTH_REQUIRED=true`. Under auth-required mode the app server **fails loud at boot** if `AUTH_SECRET` is missing or a placeholder, naming what's missing and the opt-out, rather than emitting cryptic 401s at request time. Set `AUTH_REQUIRED=false` for local dev/eval — that runs everything as the configured service (proxy) account with no login.

Two independent gates, one per HTTP surface (`AUTH_REQUIRED=false` = dev/open):

- **App server** (`apps/server/src/middleware/auth.ts`) — gates all `/api/v1/*` (health is registered *before* the gate, so it stays open). Under `AUTH_REQUIRED=true` it accepts, in order: the web session's per-user token via the **`X-RPI-Token`** header (validated against RPI's `validate-token-status`) — checked **first, before the `Authorization` early-401**, or that path would be dead code since a native-login session carries no API key; an `rpai_`-prefixed API key (SHA-256 hashed, looked up in the `api_keys` table); or an OIDC JWT (JWKS-verified). Fail-closed: no valid credential of any kind → 401. `AUTH_REQUIRED=true` also requires a real `AUTH_SECRET` — the server refuses to boot with a missing or placeholder one.
- **MCP server** (`packages/mcp-rpi/src/middleware/auth.ts`) — gates `/mcp`. Under `AUTH_REQUIRED=true` it validates the `Authorization: Bearer` token by **issuer**: a Keycloak-issued JWT (whose `iss` matches the discovered OIDC issuer) gets the JWKS crypto verify (fast local crypto); an RPI-native token — also a JWT, but signed by RPI's own IdentityServer, a *different* issuer — skips the Keycloak verify and is validated directly against `validate-token-status`. Issuer-routed, not JWKS-first-then-fallback: the native token's `iss` never matches the Keycloak JWKS, so attempting the crypto verify only triggered a doomed remote-JWKS refetch, and the issuer gate skips it.

**Per-user identity is a *forward*, not a re-issue.** The validated user token is carried through and forwarded to RPI's Integration API on every call (`Authorization: Bearer <user token>` in `packages/mcp-rpi/src/client/rpi-api.ts`), so RPI applies that user's RBAC. A configured service-account (proxy) token is the fallback used **only when no per-user token is present** (open mode, or an internal path). Because this is a single-trust-domain gateway (an RPI token forwarded to RPI), the MCP OAuth support below deliberately does **not** enforce a strict `aud == this-server` binding.

**Stable per-user metering identity.** For a forwarded RPI-native session the billing/metering `userId` is keyed on the caller's **stable RPI user GUID** (`rpi:<guid>`, resolved from `validate-token-status`), not on a hash of the access token — the token rotates on refresh/re-login, so a token-keyed id would fragment one user's usage across many ids. Identity resolution is fail-closed: a validated token that resolves no stable id is treated as an auth failure, never silently token-hashed (`apps/server/src/middleware/auth.ts`).

### Web login paths (native RPI + SSO)

The web app (`apps/web/lib/auth.ts`, NextAuth v5) offers two human sign-in paths; both end by forwarding the resulting token as `X-RPI-Token` (Mechanism B above), so tool calls run as the real user and metering keys to `rpi:<guid>`.

- **Native RPI** — OAuth2 password grant against RPI's `/connect/token` (confidential client). Always available.
- **SSO (Keycloak)** — the intended primary path: a NextAuth Keycloak **OIDC provider** doing **authorization_code + PKCE (S256)** as a **public client** (no client secret). Config is **discovered**, not hardcoded: the realm issuer comes from RPI `login-settings`' public `openIDIssuer` (never its cluster-internal `tokenEndpoint`), and NextAuth resolves authorize/token/jwks from that issuer's `.well-known`. The Keycloak JWT is accepted by RPI directly and by the app-server OIDC branch. Login-hardening: brand-free generic labels; credential fields render readonly-until-focus so the browser can't pre-fill across the stacked forms.

**Accurate state (as built):**
- The **redirect SSO flow is LIVE-VERIFIED**: with the app's redirect URI registered on the realm's client, the full authorize → login → callback round-trip works (verified locally). Production still requires the hosted redirect URI to be registered once the deploy host is assigned.
- An **interim Keycloak password-grant provider** is the working bridge meanwhile (same discovered public endpoint, public client, no secret) — it needs no redirect-URI registration, so Keycloak accounts can sign in today. It is intended to be dropped once the redirect URI is registered.
- This realm currently has **no corporate IdP federation** (native Keycloak accounts only — no Microsoft/Entra button). Corporate/Windows sign-in requires the realm to be federated later; that is a Keycloak-side change, separate from this app.

### Per-request Environment Location (which RPI instance)

A rep can point a session at a specific RPI instance ("Environment Location") without any per-deployment reconfiguration — the target URL is a **per-request** value threaded through the whole stack, exactly like the per-user token, rather than the single boot-time `RPI_INTEGRATION_API_URL`. The chain: the login carries the chosen instance URL (SSRF-validated) → the token grant targets **that** instance → the URL rides the session JWT (`rpiUrl`, server-side only, never projected into the session) → it is forwarded as an **`X-RPI-URL`** header alongside `X-RPI-Token` → the app server SSRF-validates it and bakes it into the **per-user ephemeral MCP transport** → the mcp-rpi middleware surfaces it on `authInfo.targetUrl` → the tool-registration choke point preserves it → each tool handler threads it as the RPI client's `baseUrl` → the **outbound RPI fetch targets the rep's instance**. (The same URL rides read-path forwards and the lazy token refresh, so the whole session stays on one instance.)

Invariants:

- **Off by default.** The allowlist (`RPI_URL_ALLOWLIST`, comma-separated host domains) is **empty** unless configured, so no per-request URL is accepted and no vendor domain is hardcoded — the feature is inert until a deployer opts in.
- **Backward-compatible.** With no `X-RPI-URL` (the default, and every non-interactive/proxy path), requests use the boot `RPI_INTEGRATION_API_URL`; the allowlist never gates that default.
- **SSRF-guarded at all three entries** (web login, app server, mcp-rpi): a non-allowlisted or non-`https` URL is rejected — never connected to.
- **Fail-loud, not silent-default.** The RPI client's per-call `baseUrl` is a **required** option, so a tool call that forgets to thread the location is a **compile error**, never a silent fall-back to the wrong instance — the wrong-tenant-data class is eliminated at build time.

**Login UX.** The **Environment Location** field sits at the **top** of `/login`, above the sign-in chooser (mirroring the RPI desktop client's layout), and renders **only when `RPI_URL_ALLOWLIST` is configured** (an `is-enabled` boolean from `/api/rpi-location` — the allowlist contents never reach the browser; the env default URL is shown as placeholder). A present-but-non-allowlisted entry surfaces an explicit "location isn't permitted" message distinct from a credential failure.

**All three auth paths honor the location.** The selected instance governs sign-in regardless of how the rep authenticates — it is not tied to native RPI. On the two credential paths (**native RPI** and the **SSO password grant**) the URL rides as a sign-in credential; on the **SSO redirect** path — where a full-page OAuth redirect can't carry a credential — it is carried across the round-trip in a short-TTL, `HttpOnly`, `SameSite=Lax` cookie (SSRF-validated and set *before* the redirect, overwritten per attempt, cleared on the callback), which the JWT callback reads and folds into the same session `rpiUrl`. All three therefore converge on the identical `X-RPI-URL` forwarding chain above. The location is only ever an **`rpiUrl` selector, not an issuer selector**: the central Keycloak issuer stays **static and unchanged** (no per-instance issuer discovery), which assumes the selectable instances share one SSO realm. Every SSO entry re-applies the same SSRF allowlist, and the carry is **fail-safe** — a missing, expired, malformed, or tampered cookie resolves to the boot `RPI_INTEGRATION_API_URL` default, never a wrong instance.

### Identities and what each gets (auth=true)

Under `AUTH_REQUIRED=false` every call runs as the configured service (proxy) account. Under `AUTH_REQUIRED=true` three identities are distinguished:

| Identity | How it authenticates | What it can do |
|---|---|---|
| **Service / proxy account** | env credentials → RPI password-grant | The RPI service account (typically admin). Under auth=true it is the no-user fallback **only** for genuine system/background and admin-scoped operations — never a blanket fallback for user calls. |
| **RPI-native user** | web login (or a forwarded per-user token) | Their own RPI RBAC. User-scoped tools work as them; admin/cluster operations they lack rights for return a graceful "not available for your role". |
| **API key (`rpai_`)** | app-identity key, SHA-256 looked up | Passes the app-server gate, but is **not** an RPI user and carries no RPI user token. Under auth=true, RPI tools **fail closed** for an API-key-only session; reads that don't fan out to RPI still work. |

### Per-tool scoping (fail-closed)

One declarative decision governs which token every RPI tool call runs under (`packages/mcp-rpi/src/auth-scope.ts`, applied at the single tool-registration choke point in `tool-categories.ts`). Each tool has a static **scope** — `user` (the default, fail-safe) or `admin` (the `ADMIN_TOOLS` set: the cluster-admin `/cluster/**` tools). `resolveToolAuth`:

- `AUTH_REQUIRED=false` → the proxy token for everything (dev/loose).
- `AUTH_REQUIRED=true`:
  - user token present → run **as the user** (RPI enforces their real role — covers both user and admin tools; a non-admin hitting an admin tool simply 403s at RPI).
  - no user token + admin tool → the proxy token (a genuine no-user system/background op).
  - no user token + user tool → **fail closed** (error, never a silent proxy escalation).

The HTTP client no longer carries a `userToken ?? proxyToken` fallback — the proxy decision lives *only* in `resolveToolAuth`, closing the "silent-admin" path where a missing user token was quietly upgraded to the admin account. A drift-guard test asserts every `/cluster` tool is tagged `admin`, so the set can't rot as tools are added.

### Automated / unattended testing runs on the service-account path (by design)

`AUTH_REQUIRED=false` — where every RPI call runs as the shared **service (proxy) account** (`RPI_PROXY_USER`/`RPI_PROXY_PASS`) — is **not** a degraded or legacy fallback. It is the **load-bearing substrate for unattended, automated runs**: the accuracy evaluation, CI, and regression batches. An automated batch has **no sustainable per-user RPI token** (real login tokens expire mid-run), and the per-tool scoping above is deliberately fail-closed: under `AUTH_REQUIRED=true` a session with no user token never gets a per-user RPI MCP transport built, so every user-scoped tool call fails closed (surfaces as a `503`/tools-unavailable to the caller). A batch therefore **cannot** exercise RPI tools under auth=true — the service-account path under auth=false is the only mode in which an unattended run reaches RPI at all. Removing or gating off that path would silently break the eval and CI.

This does not weaken the per-user guarantees: the accuracy census measures **routing** (which skill/tool the agent selects), a decision that is **credential-agnostic** — it is identical whichever identity ultimately executes the call — so running it under the service account is fully valid. The per-user RBAC path (native + SSO, including the Environment Location that targets a specific instance) is validated by **live/interactive testing**, not by the batch.

### Graceful authorization errors

Tool errors are classified by HTTP status into clean, role-appropriate messages — never the raw upstream body (`classifyToolError`):

- **admin-scoped tool → 403** → "not available for your role."
- **user-scoped tool → 403** → a graceful "not authorized" (normal per-user RBAC, not a defect).
- **user-scoped tool invoked with no user token (auth=true)** → a fail-closed error that is **logged** (a scoping/config signal, distinct from a routine 403).
- **401** → "session expired / sign in again."

### Connection check vs system health

"Check my connection / am I connected?" is answered by `verify_connection` (an `/info/version` probe plus OIDC/proxy/login diagnostics) in the **rpi-admin** skill — which deliberately owns **no** health tool, so a connection check *cannot* perform the cluster-admin availability probe (which would 403 for a non-admin). System health ("is the system up? any alerts?") is a **separate skill, rpi-health**. Separating the two skills makes "a connection check never performs the admin health probe" a structural guarantee, not a prompt-time hope.

### Web session lifecycle

The web gate (`apps/web/proxy.ts`) authorizes on a **live forwardable credential**, not merely the presence of a session envelope: an expired-but-refreshable session self-heals (the token is refreshed and the rotated cookie persisted); an expired or credential-less session is redirected to `/login` rather than dead-ending. Server-rendered pages forward the session's credential server-side (the raw token never reaches browser JS). `/login` offers both **RPI-native** sign-in (username/password → full per-user function) and an **API key** (app identity).

**OIDC provider discovery** (`packages/mcp-rpi/src/client/oidc-discovery.ts`) — at boot (when auth is required) the MCP server reads RPI's own login settings to discover the configured OpenID provider: its issuer, JWKS URI, and expected audience. Token validation then enforces both issuer and audience against that provider — so "what counts as a valid user token" is defined by RPI's configuration, not hard-coded here.

**Retail MCP OAuth discovery** (`packages/mcp-rpi/src/oauth-metadata.ts`) — so an external, spec-compliant MCP client (e.g. Claude Desktop, MCP Inspector, a browser client) can connect under `AUTH_REQUIRED=true` without a pre-shared token, the MCP server serves standard OAuth resource-server discovery:

- **RFC 9728 Protected Resource Metadata** at `/.well-known/oauth-protected-resource` and the path-inserted `/.well-known/oauth-protected-resource/mcp` (both unauthenticated) — advertising the discovered OIDC provider as the authorization server.
- **`WWW-Authenticate`** on *every* 401 (missing / invalid / expired), pointing at that metadata so a mid-session client whose token expired can re-discover and re-auth.
- **CORS that exposes `WWW-Authenticate`** (plus OPTIONS preflight) — without this, browser MCP clients can't read the challenge cross-origin and discovery silently fails (the most common real-world breakage).

The client then runs the standard flow against the discovered provider (authorization-code + PKCE, dynamic client registration), gets a per-user token, and connects. The server's externally-reachable origin can be pinned with `RPI_MCP_PUBLIC_URL` when it sits behind a proxy. **Audience model (soft-aud):** the metadata advertises the canonical resource URL and the server reuses the same validate-and-forward path rather than requiring the token be audience-bound to the MCP server itself; the spec-pure alternative (RFC 8693 token-exchange) is documented in-code for any future cross-resource need.

**Whether a per-user SSO token is accepted *end-to-end* is a property of RPI's user-management configuration, not of this codebase.** In the **external-users** configuration RPI's Integration API accepts the OIDC provider's per-user JWT directly (identity keyed by the token subject). In the **native-users** configuration, native users authenticate against RPI's own password-grant token service, so a raw SSO JWT is not accepted for them — a credential-to-RPI-token exchange step is required (the Data Readiness Hub backend implements the equivalent pattern; identity is linked across the two user stores). Federating a customer's own IdP (BYO-SSO) works by pointing the configured OpenID provider at it.

Across deployments this yields four cases: the **web app** (local env or cloud) authenticates each user through its own login and forwards their token; the **MCP server run locally with env credentials** acts as one configured identity (the proxy) when open, or per-presented-token when gated; the **MCP server in the cloud with no baked credentials** is the retail OAuth path above.

## Deployment topology

Via `docker compose up`, RedpointAI runs as **separate containers** — not a single monolith. Each subsystem has its own container with its own runtime, dependencies, lifecycle, and scaling profile:

```
┌────────────────────────────────────────────────────────┐
│  docker compose                                        │
│                                                        │
│  ┌──────────┐    ┌──────────┐    ┌──────────────┐      │
│  │   web    │ →  │  server  │ →  │   mcp-rpi    │      │
│  │  :3001   │    │  :3000   │    │    :3002     │      │
│  │ Next.js  │    │   Hono   │    │ MCP server   │      │
│  └──────────┘    └──────────┘    └──────────────┘      │
│                                  ┌──────────────┐      │
│                                  │   mcp-drh    │      │
│                                  │    :3003     │      │
│                                  │ MCP server   │      │
│                                  └──────────────┘      │
│                       ↓                                │
│                  ┌──────────┐                          │
│                  │ postgres │ (production profile)     │
│                  │  :5432   │                          │
│                  └──────────┘                          │
└────────────────────────────────────────────────────────┘
```

**Why separate containers:**

| Concern | What this gets you |
|---------|---------------------|
| Independent lifecycle | Restart `mcp-rpi` for a tool fix without dropping web sessions or interrupting in-flight LLM calls. |
| Failure isolation | If an MCP server crashes, `web` stays up and the affected workspace card says why instead of the whole system going dark. **Both** MCP servers degrade rather than exit on their most common failure — missing credentials: the HTTP listener stays up, tool registration is skipped, and `/health` reports `mcp: "degraded"` with `reason` and `missing[]`. Each server's required set comes from its own config contract (DRH's proxy credentials, for instance, are required only when the proxy is enabled), so the report never names a variable the operator deliberately left unset. The orchestrator reduces each connection to ONE state in `runtime-status` — `not_configured` → `unauthorized` → `unreachable` → `no_tools` → `ok`, specific signals before the catch-all, since a 401 also fails the probe — and the card renders that one line. Cards stay clickable in every state, because the Config tab is where the detail lives. |
| Different runtimes | `server` and `mcp-rpi` are Bun, `web` is Next.js (Node). Different base images, different deps, different build steps. One container would force a single-runtime compromise. |
| Independent scaling | `web` and `server` are stateless and can horizontally scale; `mcp-rpi` is mostly stateless and scalable; `postgres` is single-instance. Each tier scales for its own load profile. |
| Smaller images | Each container only carries what its service needs. `web` doesn't bundle `better-sqlite3`; `mcp-rpi` doesn't bundle Next.js. |

**Image sources:**

| Container | Source | Notes |
|-----------|--------|-------|
| `web` | `apps/web/Dockerfile` | Built from this repo |
| `server` | `apps/server/Dockerfile` | Built from this repo |
| `mcp-rpi` | `packages/mcp-rpi/Dockerfile` | Built from this repo |
| `mcp-drh` | `packages/mcp-drh/Dockerfile` | Built from this repo — Data Readiness Hub MCP server (sibling to mcp-rpi). DRH config comes from the single root `.env` (same file feeds all services); boots degraded when unconfigured. |
| `postgres` | Official `postgres:16-alpine` image | Pulled, not built — commodity dependency maintained upstream |

Four of the five containers are built from code in this repo; PostgreSQL is pulled as a stock image rather than rebuilt locally, which is the standard pattern for commodity infrastructure (databases, caches, brokers). This keeps our security surface to the code we own.

A single all-in-one container is a possibility for resource-constrained edge deployments, but it requires a process supervisor inside the container and forfeits the benefits above. We don't ship one.

## Key Technologies

| Component | Technology | Role |
|-----------|-----------|------|
| Runtime | Bun.js | Fast HTTP, native TypeScript |
| Agent Engine | Vercel AI SDK | Provider-agnostic tool calling and streaming |
| Protocol | AG-UI | Open standard for agent-frontend streaming |
| MCP | `@modelcontextprotocol/sdk` | Standard tool protocol |
| HTTP | Hono | Lightweight, middleware-rich framework |
| Validation | Zod | Runtime type checking for schemas and API inputs |
| Database | SQLite (dev) / PostgreSQL (prod) | Persistence via Drizzle ORM |
| Auth | OIDC / API keys | JWT validation + API key middleware |
| A2A | `@a2a-js/sdk` + Express | Optional inbound Agent-to-Agent protocol server (port 4100) |
