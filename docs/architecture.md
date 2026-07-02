# Architecture

## Overview

RedpointAI is a two-layer system. The **MCP layer** wraps RPI's Integration API as standard MCP tools that any client (Claude Desktop, Cursor, or RedpointAI itself) can consume. The **Skill Router layer** groups those tools into domain-specific skills, routing agent requests through a token-efficient catalog instead of exposing all 30+ tools at once.

### Architecture evolution

The system has grown through five tool- and knowledge-exposure / interop generations; all five live in the codebase today (the major version tracks this generation):

1. **Flat tooling** — every MCP tool exposed at once. Now the Tier-3 fallback only (token-heavy; safety net, not a target).
2. **Categorical tooling** — on-demand category discovery via a single `tools_list` meta-tool (Tier 2). Activates when the MCP server sets the boolean `listTools.supportsFiltering: true` in its initialize handshake (checked by `resolveTier()`); wired but runtime-inactive — the RPI MCP server doesn't set it yet.
3. **Skill routing** — one `execute_skill` meta-tool over a compact skill catalog (~500 tokens vs ~15k to expose every tool flat), dispatching to isolated sub-agents (Tier 1). **The live production path — and, from a token perspective, the most economical (lowest $) of the three tool-exposure tiers: the LLM sees a tiny catalog instead of the full tool surface on every turn.**
4. **A2A** — inbound agent-to-agent server (JSON-RPC 2.0 + public agent card) so other agents can call this one. Off by default; enable by setting the boolean `A2A_ENABLED=true` (with `A2A_WORKSPACE_ID` + `A2A_BEARER_TOKEN`).
5. **Grounded dispatched knowledge** — a tool-less domain expert (`dispatch: true`) dispatched on knowledge intent via `execute_skill`, answering **strictly from a curated body** (grounded: it refuses rather than inventing from training knowledge when that body is absent). A new *knowledge*-exposure shape, distinct from inlined experts (always-on, in-prompt) and from action dispatch (tools): the curated knowledge loads into a sub-agent only when a domain question hits it, so depth costs the parent prompt nothing. Currently `rpi-domain-expert` (the curated body is SME-authored; the skill ships with the grounding rule + an empty body it refuses on until filled).

Details for the tool-exposure tiers are in [Tool-exposure tiers](#tool-exposure-tiers-graceful-degradation); A2A lives in `apps/server/src/a2a/`; the dispatched-knowledge shape is in [Layer 2](#layer-2-skill-router-agent-orchestration).

## System Diagram

```
Frontend (Next.js)
  |  useChat / AG-UI (SSE)
  v
Backend (Bun + Hono)
  |-- Workspace Manager     — CRUD for workspace configs
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
| `packages/mcp-rpi` | Standalone MCP server wrapping RPI's Integration API (47 tools across 8 domains: admin, audiences, auth, clients, file-system, folders, interactions, selection-rules) |
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

The RPI MCP server is a standalone process exposing RPI capabilities via the Model Context Protocol. It supports both stdio (for Claude Desktop) and HTTP (for production). Any MCP client can connect independently of RedpointAI.

### Layer 2: Skill Router (agent orchestration)

For RedpointAI's own agent, MCP tools are grouped into skills. Expert (knowledge-only) skills come in two shapes:

- **Inlined experts** (default) are folded directly into the system prompt as "Domain Knowledge" sections — used for cross-cutting, always-on guidance (e.g. the foundation expert: client/tenant ID, terminology, error conventions). Cheap to read, but every inlined body taxes *every* request.
- **Dispatched experts** (`dispatch: true`, e.g. `rpi-domain-expert`) are knowledge-only but **not** inlined — they appear in the catalog as a tool-less `(knowledge)` entry and are reached via `execute_skill`, so a deep curated body loads into a sub-agent **only on a knowledge-intent hit** and costs the parent prompt nothing. A dispatched expert carries a grounding rule: it answers strictly from its curated body and refuses (rather than inventing from training knowledge) when that body is absent.

Action and hybrid skills appear in the same compact catalog (~500 tokens) reached through one `execute_skill` meta-tool, instead of 30+ individual tool schemas (~15k tokens). Each action/hybrid/dispatched-expert invocation spawns an isolated sub-agent — action/hybrid sub-agents get the relevant tools; a dispatched expert's sub-agent gets none (knowledge only).

**Why both?** MCP provides standard interop. The skill router provides token efficiency and domain isolation, which are critical given RPI's large API surface.

### Tool-exposure tiers (graceful degradation)

The agent always tries to expose **as few tools as possible** to the LLM. Tiers, in priority order:

1. **Tier 1 — Skill router (best)**: ONE tool exposed (`execute_skill`). The router LLM picks a skill by name; an isolated sub-agent runs with that skill's instructions and tools. Used when the workspace has any action/hybrid skills configured. Within a sub-agent: if the skill's `mcpToolFilter` is **absent**, the sub-agent gets ALL discovered MCP tools at runtime (dynamic discovery — survives upstream tool churn). If `mcpToolFilter` is **present**, it acts as opt-in scoping for security/focus/multi-server isolation.

   **Operation-class narrowing (Pattern A):** a heavy skill may also declare an `operations:` map in its SKILL.md frontmatter (e.g. `list`, `get`, `count`, `metadata`, `workflow`), each mapping to a narrower tool subset. When the router passes an `operation` to `execute_skill(skill, input, operation?)`, the sub-agent receives that subset instead of the full `mcpToolFilter`, shrinking the sub-agent prompt (~10K → 2-4K tokens on common list/get prompts). A missing or unknown operation falls back to `mcpToolFilter` — safe by design. Live on `rpi-audiences`, `rpi-interactions`, `rpi-selection-rules` (schema in `packages/skills/src/skill.ts`).

   **Routing on intent, not the surface verb (Guideline #11):** the operation is chosen from what the request *wants*, not its leading word. A count predicate — "list rules **with counts > 0**", "non-zero", "size > N" — is a COUNT intent → `operation:"count"`, even though the verb is "list" (routing it to `list` strips the count tool and the sub-agent can't deliver). Counts are per-rule jobs (no bulk-count endpoint), so the `count` path **counts at most the first ~10 rows in list order, then stops** — a hard per-turn cap that bounds what would otherwise be a ~9-minute grind on a 242-rule set. Results are reported scoped to "the first N of M matching" (ask about a specific rule for its detail); the response never claims completeness about the un-counted rows.
2. **Tier 2 — Category discovery (mid)**: ONE tool exposed (`tools_list`). The LLM browses categories on demand and pulls just the schemas it needs. Used when the workspace has no actionable skills but the connected MCP server advertises `supportsFiltering`. Tier selection is wired into the chat route via `resolveTier()` (`apps/server/src/agents/tier-resolver.ts`, called in `routes/chat.ts`); this tier activates only when **every** connected MCP server advertises `supportsFiltering`, which the RPI MCP server does not yet — so it is wired but runtime-inactive today.
3. **Tier 3 — Flat (fallback)**: All discovered MCP tools exposed at once. Used only when neither skills nor server-side filtering are available. This is the worst case for token efficiency and tool-selection accuracy and is meant as a safety net, not a target state.

**Authoring rule for skill bodies**: Skill prose (the SKILL.md body) must NEVER name specific MCP tools. Tool descriptions live in the MCP server's tool source and are discovered at runtime; skill bodies prime *domain knowledge* (entities, vocabulary, patterns), nothing else. This keeps skills resilient when the upstream tool surface changes and lets the same prose body be lifted across agent runtimes (e.g., the terminal agent) where the wiring layer differs.

## Cross-cutting subsystems

The following were ported from the v3 terminal agent and now live in `apps/server`:

- **Provider-aware schema middleware** (`apps/server/src/config/schema-middleware.ts`) — wraps every LLM model to strip JSON-Schema fields that specific providers reject (Anthropic strictness, Azure quirks). Applied at model construction in `createModelFromConfig()` so every tool schema flowing to any provider is cleaned automatically.

- **Deterministic + bounded + resilient LLM calls** — three settings applied at every parent (`orchestrator.ts`) and sub-agent (`router.ts`) call site, plus the Azure provider's `fetch`: (a) **`temperature: 0`** — skill/operation routing must be reproducible; the default ~1.0 made the same prompt route differently run-to-run (and the accuracy eval wobble). (b) **`maxOutputTokens` bounds** (parent 2000 / sub-agent 3000) — Azure's per-call TPM *admission estimate* is `prompt + maxOutputTokens`, so an unbounded call is charged the model max (~16K) and 429s on a tight bucket even though real output is ~200 tokens. (c) **Reactive retry-after fetch wrapper** (`apps/server/src/config/retry-fetch.ts`, wired via `createRetryAfterFetch()` into `createAzure({ fetch })`) — on a 429 it waits the deployment's *real* `retry-after` and refires, ignoring Azure's misleading `retry-after-ms: 0` (which the SDK's built-in retry follows and fast-fails on). Bounded by a 75s total budget. NB: each Azure **deployment id is its own TPM bucket**, so routing a workspace at a less-contended deployment (e.g. `gpt-4.1`'s 100K vs a shared `gpt-4o`'s 10K) is a config change, not a model downgrade — see `docs/providers.md`.

- **Patched MCP transport** (`apps/server/src/mcp/patched-transport.ts`) — custom HTTP transport for `MCPClientManager` with two jobs: (a) compat patches (`protocolVersion`, `serverInfo`) for non-spec-compliant MCP servers, and (b) capturing `serverCapabilities` from the initialize response so downstream code can tell whether a server supports category filtering.

- **MCP category discovery** (`apps/server/src/mcp/mcp-category-discovery.ts`) — when a connected MCP server advertises `supportsFiltering` with `availableCategories`, this module synthesizes a `tools_list` meta-tool so the agent discovers tools by category on demand instead of being handed every tool schema upfront. Tier selection is wired (`resolveTier()` in the chat route); this path stays runtime-inactive until the RPI MCP server enables filtering.

- **Hallucination detection** (`apps/server/src/agents/hallucination-detector.ts`) — `onStepFinish` callback in the chat route. Detects cases where the model asserts an action completed (e.g., "stored successfully") without having called `execute_skill`. Logs an audit event and increments the `hallucinationsTotal` Prometheus counter. Detection-only; no mid-stream retry (would double latency for a minority case).

- **A2A inbound server** (`apps/server/src/a2a/`) — JSON-RPC 2.0 Agent-to-Agent protocol server, feature-flagged via `A2A_ENABLED`. Exposes an Agent Card at `/.well-known/agent-card.json` and a JSON-RPC endpoint at `/` (Bearer auth). Lets other agents call this agent over HTTP. Lives on a separate port (`A2A_PORT`, default 4100), bootstrapped from `apps/server/src/index.ts` only when enabled.

- **Provider-agnostic prompt caching** (`packages/skills/src/caching-options.ts`) — single `cachingOptions` constant passed as `providerOptions` at every `streamText` / `generateText` / `ToolLoopAgent` call site (orchestrator, agui route, skill router sub-agent). The Vercel AI SDK silently drops keys for inactive providers, so one constant covers Anthropic (~90% off cached prefixes via explicit `cacheControl`) and OpenAI/Azure (~50% off >1024-token prefixes via `promptCacheRetention: '24h'`) with zero branching. Verified via `tokens.cached` / `tokens.cacheCreated` fields on the `TelemetryEvent.tokens` shape — populated from `usage.inputTokenDetails` and surfaced inline in step-finish messages so traffic exports show binary "is it firing?" verification (turn-2 should have `cached:N`).

- **Web build-version surface** (`apps/web/version.json` → `apps/web/lib/version.ts` → `apps/web/components/chat/info-panel.tsx` Config-tab Row) — a committed `{ "version": "…" }` inlined into the client bundle at build (static import, not a runtime read). The value is a **manually-stamped `MAJOR.MINOR`** string — MAJOR tracks the architecture generation (the five above; currently 5 = grounded dispatched knowledge), MINOR is a per-cycle counter bumped each merge cycle (reset to 0 when MAJOR advances). Automatic derivation (from a release tag / commit SHA) is deferred to the publish pipeline. Build-inert: no `.git`/CI needed at build, ships as-is in the zip/image.

## Deployment topology

In production (and via `docker compose up` locally), RedpointAI runs as **separate containers** — not a single monolith. Each subsystem has its own container with its own runtime, dependencies, lifecycle, and scaling profile:

```
┌────────────────────────────────────────────────────────┐
│  docker compose                                        │
│                                                        │
│  ┌──────────┐    ┌──────────┐    ┌──────────────┐      │
│  │   web    │ →  │  server  │ →  │   mcp-rpi    │      │
│  │  :3001   │    │  :3000   │    │    :3002     │      │
│  │ Next.js  │    │   Hono   │    │ MCP server   │      │
│  └──────────┘    └──────────┘    └──────────────┘      │
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
| Failure isolation | If `mcp-rpi` crashes, `web` stays up and shows a degraded "MCP unreachable" state instead of the whole system going dark. (mcp-rpi also degrades rather than exits on its most common failure cause — missing RPI credentials: it keeps the HTTP listener up, skips RPI tool registration, and reports degraded state via `/health` and `/mcp`.) |
| Different runtimes | `server` and `mcp-rpi` are Bun, `web` is Next.js (Node). Different base images, different deps, different build steps. One container would force a single-runtime compromise. |
| Independent scaling | `web` and `server` are stateless and can horizontally scale; `mcp-rpi` is mostly stateless and scalable; `postgres` is single-instance. Each tier scales for its own load profile. |
| Smaller images | Each container only carries what its service needs. `web` doesn't bundle `better-sqlite3`; `mcp-rpi` doesn't bundle Next.js. |

**Image sources:**

| Container | Source | Notes |
|-----------|--------|-------|
| `web` | `apps/web/Dockerfile` | Built from this repo |
| `server` | `apps/server/Dockerfile` | Built from this repo |
| `mcp-rpi` | `packages/mcp-rpi/Dockerfile` | Built from this repo |
| `postgres` | Official `postgres:16-alpine` image | Pulled, not built — commodity dependency maintained upstream |

Three of the four containers are built from code in this repo; PostgreSQL is pulled as a stock image rather than rebuilt locally, which is the standard pattern for commodity infrastructure (databases, caches, brokers). This keeps our security surface to the code we own.

A single all-in-one container is a possibility for resource-constrained edge deployments, but it requires a process supervisor inside the container and forfeits the benefits above. We don't ship one. See [docs/deployment.md](deployment.md) for the operational walkthrough (commands, env vars, scaling, profiles).

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
