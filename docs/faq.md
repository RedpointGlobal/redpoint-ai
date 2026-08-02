# RedpointAI FAQ

The comprehensive guide for RPI customers looking to leverage AI and agentic capabilities. If your question isn't answered here, check the other [docs](../README.md#documentation) or contact support@redpointglobal.com.

---

## Table of Contents

1. [General / What Is This?](#1-general--what-is-this)
2. [Getting Started](#2-getting-started)
3. [Workspaces & Configuration](#3-workspaces--configuration)
4. [LLM Providers / BYOM](#4-llm-providers--byom)
5. [Skills & Skill Router](#5-skills--skill-router)
6. [MCP Tools & RPI Integration](#6-mcp-tools--rpi-integration)
7. [API & Integration](#7-api--integration)
8. [Authentication & Security](#8-authentication--security)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. General / What Is This?

### Q: What is RedpointAI?

RedpointAI is an open-source AI agent platform built for Redpoint Interaction (RPI). It lets you build, compose, and run AI agents that operate against your RPI instance using your own LLM provider key (BYOM). The platform exposes RPI capabilities as standard MCP tools, groups them into domain-specific skills, and provides a chat-based UI for natural-language interaction with your marketing data and operations.

### Q: How does RedpointAI relate to RPI?

RedpointAI sits on top of your existing RPI instance. It wraps RPI's Integration API as Model Context Protocol (MCP) tools, making RPI capabilities available to AI agents. Your RPI instance handles the actual data operations (audiences, campaigns, profiles, etc.) while RedpointAI provides the AI orchestration layer. RedpointAI does not modify or replace any RPI functionality; it gives you a conversational interface to it.

### Q: What problems does it solve for RPI customers?

- **Natural-language access to RPI** -- ask questions like "How many VIP customers do we have?" instead of navigating the RPI UI
- **Multi-step workflow automation** -- chain together audience creation, campaign execution, and reporting in a single conversation
- **Domain expertise on demand** -- built-in expert skills for audience strategy, campaign design, data architecture, and realtime decisioning
- **Token-efficient orchestration** -- the skill router keeps costs low by exposing a compact catalog (~500 tokens) instead of 30+ tool definitions (~15k tokens)
- **Provider flexibility** -- use Anthropic, OpenAI, Google, Azure, or Ollama depending on your requirements and compliance needs

### Q: What is the licensing model?

See the [LICENSE](../LICENSE) file in the repository root for details.

### Q: What LLM providers are supported?

Three providers are selectable from the environment: **Azure OpenAI**, **Anthropic** (Claude), and **OpenAI** (GPT) — the seed picks by key presence (Azure → Anthropic → OpenAI). **Google** and **Ollama** are wired in the provider factory but are not part of the environment-driven selection. Provider and model come from the environment; there is no in-app switcher. See [Providers](providers.md) for details.

### Q: Is this production-ready?

RP_AI is an OSS source project for engineers. The codebase ships with JWT/OIDC authentication, Prometheus metrics, audit logging, and PostgreSQL support — but the OSS repo itself is not a supported production deployment vehicle. For production use, contact support@redpointglobal.com. At minimum, set `AUTH_REQUIRED=true` before exposing any instance beyond localhost.

---

## 2. Getting Started

### Q: What are the prerequisites?

Both paths start from a clone + `bun install`; the footprint differs from there:

- **Code contributor** (run the stack) — Bun ≥ 1.3.0, Node ≥ 22.6, an LLM API key, optionally an RPI instance for MCP.
- **Agent developer** (build the MCP binary) — Bun to build; the compiled binary is self-contained (no Bun/Node needed to run it), plus an MCP client that can speak to `http://localhost:3002/mcp`.

### Q: How do I install and run locally?

Two paths, both from one clone — pick yours:

**Code contributor** (run the full stack):
```bash
curl -fsSL https://bun.sh/install | bash    # one-time, if Bun missing
git clone https://github.com/RedpointGlobal/redpoint-ai.git
cd redpoint-ai && bun install && bun run dev
```

**Agent developer** (build the standalone MCP binary): clone + `bun install`, then `cd packages/mcp-rpi && bun run build:linux` (or `build:windows`), run the binary, and point your MCP client at `http://localhost:3002/mcp`. See [Standalone MCP Server](rpi-mcp-server.md) for details.

`cp .env.example .env` first and add at least `ANTHROPIC_API_KEY`. The server lazy-bootstraps the SQLite schema and seeds default workspaces on first start. See [Getting Started](getting-started.md) for the full contributor walkthrough.

### Q: What environment variables are required?

At minimum, you need one LLM provider key. The root `.env.example` is the reference — its layout:

| Block | Variables | Notes |
|-------|-----------|-------|
| LLM provider (one required) | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_RESOURCE_NAME` (+ `DEPLOYMENT_ID`, `API_VERSION`) | Seed precedence: Azure → Anthropic → OpenAI. Single-key alternatives: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. |
| App auth | `AUTH_REQUIRED` (`false` dev default), `AUTH_SECRET` | `AUTH_SECRET`: generate with `openssl rand -base64 32` |
| RPI | `RPI_INTEGRATION_API_URL`, `RPI_OAUTH_CLIENT_ID`/`_SECRET`, `RPI_DEFAULT_CLIENT_ID`, `RPI_PROXY_USER`/`_PASS`/`_ENABLED` | Your on-premises RPI instance + tenant + optional proxy service account |
| DRH | `DRH_API_URL`, `DRH_DEFAULT_CLIENT_ID`, `DRH_DEFAULT_DATABASE_ID`, `DRH_PROXY_USER`/`_PASS` | `DRH_API_URL` is also the provisioning switch — unset means no DRH card |

### Q: How do I verify the platform is working?

The fastest path is `bun run check` (verifies install invariants — Bun version, lockfile, native bindings, schema apply, env-vars). Optional flag:

```bash
bun run check              # default
bun run check --running    # also curl the three live health endpoints (run after `bun run dev`)
```

For a more granular look, hit the underlying endpoints directly:

```bash
# Health check
curl http://localhost:3000/api/v1/health
# Expected: {"status":"ok","version":"0.1.0","runtime":"bun",...}

# List configured providers
curl http://localhost:3000/api/v1/providers
# Expected: array of providers with configured:true

# List workspaces (auto-seeded: Redpoint Interaction + Data Readiness Hub)
curl http://localhost:3000/api/v1/workspaces
# Expected: array with 1 default workspace
```

Then open `http://localhost:3001` in your browser to access the chat UI.

### Q: How do I connect to my RPI instance?

Set `RPI_INTEGRATION_API_URL` to your on-premises RPI instance in `.env`:

```env
RPI_INTEGRATION_API_URL=https://rpi.your-company.com
RPI_OAUTH_CLIENT_ID=your-oauth-client-id
RPI_OAUTH_CLIENT_SECRET=your-oauth-client-secret
RPI_DEFAULT_CLIENT_ID=your-rpi-tenant-id
# Optional proxy user (native RPI service account fallback)
RPI_PROXY_USER=your-service-account
RPI_PROXY_PASS=your-service-account-password
RPI_MCP_HTTP_PORT=3002
```

Then start the MCP server (`bun run dev:mcp` or included in `bun run dev`). Add an MCP connection to your workspace configuration pointing to `http://localhost:3002/mcp`. The MCP server will fail to start if `RPI_INTEGRATION_API_URL`, `RPI_OAUTH_CLIENT_ID`, `RPI_OAUTH_CLIENT_SECRET`, or `RPI_DEFAULT_CLIENT_ID` is not set. Callers authenticate via Bearer token (native RPI or OIDC); the optional proxy user is used as a fallback when no per-user token is present — set `RPI_PROXY_ENABLED=false` to force-disable it.

### Q: What workspaces ship by default?

On first run the server seeds two product workspaces and keeps them authoritative: **Redpoint Interaction (RPI)** and **Data Readiness Hub (DRH)**. Both always appear, whether or not their backends are configured — an unconfigured backend simply means that workspace's MCP server isn't reachable.

Their configuration comes from the seed (code) plus the environment, and is rewritten on every boot. There is no supported way to create a workspace or edit one from the UI: anything outside the seeded set is removed on the next restart, so a hand-created workspace would not survive.

---

## 3. Workspaces & Configuration

### Q: What is a workspace?

A workspace is an isolated agent environment with its own model configuration, system prompt, MCP connections, skills, and suggested prompts. Think of it as a purpose-built AI agent -- one workspace might be a marketing operations agent, another might be a customer insights analyst.

### Q: How do I create a workspace?

Via API:

```bash
curl -X POST http://localhost:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Marketing Ops",
    "description": "Marketing operations agent",
    "provider": {
      "type": "anthropic",
      "model": "claude-sonnet-4-6"
    },
    "agent": {
      "systemPrompt": "You are a marketing operations specialist...",
      "maxSteps": 25
    },
    "mcp": [{
      "name": "rpi",
      "transport": "http",
      "url": "http://localhost:3002/mcp"
    }],
    "skills": ["rpi-audiences", "rpi-foundation-expert"],
    "suggestions": ["Show me all active audiences"]
  }'
```

Or via the web UI at `http://localhost:3001`. See [Workspaces](workspaces.md) for full details.

### Q: What are the workspace configuration options?

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Workspace name (1-255 chars) |
| `description` | No | What this workspace is for |
| `provider.type` | Yes | `anthropic`, `openai`, `google`, `azure-openai`, `ollama` |
| `provider.model` | Yes | Model identifier (e.g., `claude-sonnet-4-6`) |
| `provider.apiKey` | No | `${ENV_VAR}` reference only; literal keys are rejected |
| `provider.baseUrl` | No | Custom endpoint URL |
| `agent.systemPrompt` | No | Agent instructions (default: "You are a helpful assistant.") |
| `agent.maxSteps` | No | Max tool-calling iterations, 1-100 (default: 20) |
| `mcp` | No | Array of MCP server connections |
| `skills` | No | Array of skill names to enable |
| `suggestions` | No | Suggested prompts shown in chat UI |

### Q: Can I have multiple workspaces?

Yes. Create as many as you need -- each is independent with its own provider, tools, and skills. Common setups include separate workspaces for marketing ops, customer insights, content management, and system administration.

### Q: How do I switch between workspaces?

In the web UI, use the workspace selector. Via API, simply target a different workspace ID in your requests: `POST /api/v1/workspaces/:workspaceId/chat`.

### Q: What is the system prompt and how should I write one?

The system prompt (`agent.systemPrompt`) is the instruction set given to the LLM at the start of every conversation. It defines the agent's persona, capabilities, and behavioral guidelines. Tips:

- Be specific about the agent's role and domain
- List what the agent can and cannot do
- Include guidelines for handling sensitive operations (e.g., "Always confirm before executing workflows")
- Keep it concise -- every token in the system prompt is sent with every request
- Reference the skill catalog if using skills (the router appends this automatically)

### Q: How do workspace-level settings interact with global settings?

Workspace settings override global defaults. For example, if you set `ANTHROPIC_API_KEY` in your `.env` file, all workspaces using the `anthropic` provider type will use that key unless the workspace points at a different env var via `provider.apiKey` (a `${ENV_VAR}` reference — literal keys are rejected, so a secret never lands in the database). Similarly, the default system prompt is used unless the workspace provides its own `agent.systemPrompt`.

---

## 4. LLM Providers / BYOM

### Q: What does BYOM (Bring Your Own Model) mean?

BYOM means you bring your own LLM provider key. RedpointAI doesn't lock you into a single provider — set the key for the provider you want in `.env`, and the seed configures the workspaces from it on boot.

### Q: Which providers are supported?

| Provider | Env Variable | Selection |
|----------|-------------|-----------|
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_RESOURCE_NAME` | env-selectable (first precedence) |
| Anthropic | `ANTHROPIC_API_KEY` | env-selectable |
| OpenAI | `OPENAI_API_KEY` | env-selectable |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | wired in the provider factory; not part of the env-driven selection |
| Ollama | *(none — local daemon)* | wired in the provider factory; not part of the env-driven selection |

See [Providers](providers.md) for setup instructions for each.

### Q: How do I configure a provider?

Set exactly one provider's key in the root `.env` for a turnkey run (if multiple are set, Azure wins). Override the model with the provider's model variable (`AZURE_OPENAI_MODEL` / `AZURE_OPENAI_DEPLOYMENT_ID`, `ANTHROPIC_MODEL`, `OPENAI_MODEL`); sensible defaults apply when unset. The seed rewrites each workspace's provider/model from the environment on every boot — configuration is `.env` + seed, not the UI or the API.

### Q: Can I use different providers for different workspaces?

No. The seed derives one provider from the environment and applies it to the seeded workspaces on every boot. Changing provider = changing the key in `.env` and restarting.

### Q: How do I check which providers are configured?

```bash
curl http://localhost:3000/api/v1/providers
```

Returns an array of providers showing which ones have API keys configured and their available models.

---

## 5. Skills & Skill Router

### Q: What is a skill?

A skill is a domain-specific capability defined by a `SKILL.md` file. It packages a system prompt, optional MCP tool access, and behavioral guidelines into a reusable module. Skills come in three types:

| Type | Has Tools? | Use Case |
|------|-----------|----------|
| **action** | Yes | Direct RPI operations (create audiences, run campaigns) |
| **expert** | No | Domain knowledge and advice (no tool access) |
| **hybrid** | Yes | Knowledge + execution (consults expertise, then acts) |

### Q: What is the Skill Router and how does it work?

The Skill Router is a token-efficient orchestration pattern that uses a two-tier approach. Instead of giving the agent all 30+ MCP tools (which costs ~15k tokens per request), skills are handled based on type:

**Expert skills** (knowledge-only) are inlined directly into the system prompt as "Domain Knowledge" sections via `buildRouterSystemPrompt()`. The agent answers knowledge questions immediately without any tool call.

**Action/hybrid skills** appear in a compact catalog (~500 tokens) and are dispatched via `execute_skill`:

1. Presents a compact skill catalog listing action/hybrid skill names and descriptions
2. Exposes a single `execute_skill` meta-tool
3. For knowledge questions, the agent answers directly from inlined expert knowledge
4. For action requests, the agent calls `execute_skill(skillName, input)`
5. A sub-agent spawns with only that skill's MCP tools and domain instructions
6. The sub-agent executes the task and returns results to the router
7. The router relays results to the user

This reduces per-request token costs by ~97% compared to exposing all tools directly, and eliminates unnecessary tool-call round trips for knowledge questions.

### Q: What skills come pre-built?

Skills come in two roles: **action skills** define the *how* (each wraps one RPI domain's MCP tools), and **expert skills** define the *what* (domain knowledge, no tools). RedpointAI ships 15 skills across the two product workspaces: 11 action skills and 4 experts.

**Action skills (the *how* — entity operations via MCP tools):**

| Skill | Type | Description |
|-------|------|-------------|
| `rpi-audiences` | action | Audiences: list/get/metadata, audience definitions, test-workflow lifecycle |
| `rpi-interactions` | action | Marketing interactions: list/get, activity tree, workflow run + instance control |
| `rpi-selection-rules` | action | Selection rules (Basic + Standard), count/waterfall/SQL-count runs |
| `rpi-clients` | action | Client (tenant/cluster) discovery |
| `rpi-folders` | action | Folder list + create |
| `rpi-admin` | action | System health, cluster error log, audit history |

**Expert skills (the *what* — domain knowledge, no tools):**

| Skill | Type | Description |
|-------|------|-------------|
| `rpi-foundation-expert` | expert | Cross-cutting essentials for every RPI tool call — client/tenant ID, folder lookups, terminology, display + error conventions. Inlined into every RPI conversation. |
| `rpi-domain-expert` | expert | Campaign-building domain knowledge — attributes, selection rules (segments), audiences, interactions, and the design strategy behind them. Dispatched on demand: loaded into a sub-agent only on a knowledge-intent hit. |

Two experts ship today: `rpi-foundation-expert` is **inlined** into every RPI conversation (cross-cutting essentials), while `rpi-domain-expert` is **dispatched** — its campaign-building knowledge loads into a sub-agent on demand, costing the parent prompt nothing (see [skills](skills.md)).

### Q: How do I create a custom skill?

1. Create a directory: `mkdir skills/my-custom-skill`
2. Add a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-custom-skill
title: My Custom Skill
description: Short description for the skill catalog
type: hybrid
mcpToolFilter:
  - list_audiences
  - get_audience_metadata
maxSteps: 15
tags: [custom]
---

# My Custom Skill

You are a specialist in...

## What You Can Do
- List and analyze audiences
- Provide audience counts

## Guidelines
- Always confirm before creating resources
```

3. Restart the server to load the new skill
4. Add `"my-custom-skill"` to your workspace's `skills` array

The `mcpToolFilter` controls which MCP tools the skill's sub-agent can access. Expert skills omit this field entirely.

### Q: How does the sub-agent architecture work?

When `execute_skill` is called, the platform spawns a fresh AI agent (sub-agent) with:

- **System prompt**: The SKILL.md body content
- **Tools**: Only the MCP tools listed in `mcpToolFilter` (filtered and namespaced)
- **Max steps**: The skill's `maxSteps` value (default: 10)
- **Same LLM provider**: Inherits the workspace's provider configuration

The sub-agent runs its task independently, makes tool calls as needed, and returns its final response to the router agent. The router then presents the result to the user.

### Q: What is token-efficient orchestration?

Without skills, every request sends all 30+ MCP tool definitions to the LLM (~15k tokens of schema). With the skill router, each request only sends:

- The skill catalog: ~500 tokens (just names and descriptions)
- The `execute_skill` tool definition: ~100 tokens
- When a skill executes: only that skill's filtered tools (typically 3-10 tools)

This dramatically reduces input token costs, especially for conversations with many back-and-forth messages.

### Q: How do skills discover and use MCP tools?

Skills reference MCP tools by their base name (e.g., `list_audiences`, not `rpi__list_audiences`). The skill router matches these against available namespaced tools from all connected MCP servers. When a skill executes, its sub-agent receives only the matching tools, namespaced with the server name (e.g., `rpi__list_audiences`).

### Q: Can I disable or restrict specific skills?

Yes. The workspace `skills` array controls which skills are available (via `registry.filterByNames()`). Only skills listed in this array are loaded -- expert skills are inlined into the system prompt and action/hybrid skills appear in the router catalog. To disable a skill, remove it from the array. If `skills` is omitted or empty, all registered skills are loaded. To use raw MCP tools directly without skills, ensure no skills are registered.

---

## 6. MCP Tools & RPI Integration

### Q: What is MCP (Model Context Protocol)?

MCP is an open standard for connecting AI models to external tools and data sources. It defines a protocol for tool discovery, invocation, and result handling. RedpointAI uses MCP to wrap RPI's Integration API as standard tools that any MCP-compatible client can consume -- including Claude Desktop, Cursor, and RedpointAI itself.

### Q: What RPI capabilities are exposed via MCP?

The RPI MCP server (`packages/mcp-rpi`) exposes 47 tools across 8 domains covering the full breadth of RPI's Integration API:

| Domain | Tools | What You Can Do |
|--------|-------|-----------------|
| **admin** | 3 | System health, cluster API error log, audit history |
| **audiences** | 13 | List/get/metadata, audience definitions, run the test-workflow lifecycle + read results |
| **auth** | 1 | Verify the RPI connection |
| **clients** | 3 | List and look up clients (tenant/cluster discovery) |
| **file-system** | 1 | Resolve a file's name/path by GUID |
| **folders** | 2 | List and create folders |
| **interactions** | 16 | List/get, walk the activity tree, triggers, run + control workflow instances, next-firing times |
| **selection-rules** | 8 | List/get (Basic + Standard subtypes), count/waterfall/SQL-count runs, document definitions |

### Q: What are the specific tools available?

**admin:** `get_system_health_availability`, `get_cluster_api_error_log`, `get_cluster_audit_history`

**audiences:** `list_audiences`, `get_audience_by_id`, `get_audience_by_name`, `get_audience_metadata`, `list_audience_definitions`, `get_audience_definition_by_id`, `get_audience_definition_by_name`, `run_audience_test_workflow`, `get_audience_workflow_activity_status`, `get_audience_workflow_block_results`, `get_audience_workflow_results`, `list_audience_test_instances`, `get_audience_execution_results`

**auth:** `verify_connection`

**clients:** `list_clients`, `get_client_by_id`, `get_client_by_name`

**file-system:** `get_file_info_by_id`

**folders:** `list_folders`, `create_folder`

**interactions:** `list_interactions`, `get_interaction_by_id`, `get_interaction_by_name`, `get_interaction_activity`, `get_interaction_trigger`, `get_interaction_available_inputs`, `get_interaction_default_metadata`, `get_interaction_workflows`, `get_interaction_workflow_activities`, `activate_interaction_workflow`, `run_interaction_workflow`, `get_workflow_instance_summary`, `get_interactions_workflow_status`, `get_interaction_workflow_instances`, `control_workflow_instance`, `calculate_interaction_next_firing_times`

**selection-rules:** `list_selection_rules`, `get_selection_rule_by_name`, `get_basic_selection_rule_by_id`, `get_standard_selection_rule_by_id`, `run_selection_rule_count`, `run_selection_rule_waterfall`, `get_selection_rule_sql_count_query`, `list_basic_selection_rule_document_definitions`

### Q: How do I connect the MCP server to my RPI instance?

Set these environment variables and start the MCP server:

```env
RPI_INTEGRATION_API_URL=https://rpi.your-company.com
RPI_OAUTH_CLIENT_ID=your-oauth-client-id
RPI_OAUTH_CLIENT_SECRET=your-oauth-client-secret
RPI_DEFAULT_CLIENT_ID=your-rpi-tenant-id
RPI_MCP_HTTP_PORT=3002
```

```bash
bun run dev:mcp   # Starts MCP server on port 3002
```

Then add an MCP connection to your workspace:

```json
{
  "mcp": [{
    "name": "rpi",
    "transport": "http",
    "url": "http://localhost:3002/mcp"
  }]
}
```

### Q: Can I add custom MCP servers beyond RPI?

Yes. The `mcp` array in workspace configuration supports multiple servers. Each gets a unique name for tool namespacing. You can connect any MCP-compatible server:

```json
{
  "mcp": [
    { "name": "rpi", "transport": "http", "url": "http://localhost:3002/mcp" },
    { "name": "custom", "transport": "http", "url": "http://localhost:4000/mcp" },
    {
      "name": "local-tool",
      "transport": "stdio",
      "command": "/path/to/mcp-server",
      "args": ["--flag"],
      "env": { "API_KEY": "..." }
    }
  ]
}
```

### Q: How does tool namespacing work?

When tools are loaded from MCP servers, they're namespaced with the connection name using double underscores: `{connectionName}__{toolName}`. For example, `list_audiences` from a server named `rpi` becomes `rpi__list_audiences`. This prevents name collisions when multiple MCP servers are connected.

### Q: What is the MCP protocol handshake flow?

The MCP client follows this sequence when connecting to an MCP server:

1. **Initialize**: Send `initialize` request with client capabilities
2. **Notification**: Send `notifications/initialized` to confirm
3. **Tool Discovery**: Send `tools/list` to get available tools (requires `Accept: application/json, text/event-stream` header for HTTP transport)

Connections are cached per workspace+server combination and reused across requests.

### Q: How do I troubleshoot MCP connection issues?

Common issues and fixes:

- **0 tools returned**: Ensure the MCP server is running and the `Accept` header includes both `application/json` and `text/event-stream`
- **Connection refused**: Check `RPI_MCP_HTTP_PORT` matches the server's port and the URL in workspace config
- **Auth failures**: Verify `RPI_INTEGRATION_API_URL`, `RPI_OAUTH_CLIENT_ID`, `RPI_OAUTH_CLIENT_SECRET`, and `RPI_DEFAULT_CLIENT_ID` are correct; if using the proxy user, check `RPI_PROXY_USER`/`RPI_PROXY_PASS`
- **Timeout**: RPI instance may be unreachable -- check network connectivity and `RPI_INTEGRATION_API_URL`
- **Tool filtering**: If `allowedTools` is set in the MCP connection config, only those tools will be available

Check the server logs (`LOG_LEVEL=debug` for verbose output) for detailed connection diagnostics.

---

## 7. API & Integration

### Q: What API endpoints are available?

All endpoints are prefixed with `/api/v1` (except `/health` and `/metrics`):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/api/v1/providers` | List configured providers |
| `GET/POST/PUT/DELETE` | `/api/v1/workspaces` | CRUD workspaces |
| `GET/POST/DELETE` | `/api/v1/workspaces/:id/threads` | CRUD threads |
| `GET/POST` | `/api/v1/workspaces/:wId/threads/:tId/runs` | Create and list runs |
| `POST` | `/api/v1/workspaces/:id/chat` | Chat (useChat-compatible) |
| `POST` | `.../runs/:rId/stream` | AG-UI event stream |
| `GET/POST/DELETE` | `/api/v1/auth/api-keys` | API key management |

See [API Reference](api.md) for full request/response schemas.

### Q: How does the AG-UI protocol work?

AG-UI (Agent-UI) is an open protocol for streaming agent responses to frontends. RedpointAI uses it over Server-Sent Events (SSE). The event flow for a typical chat request:

1. `RUN_STARTED` -- agent begins processing
2. `TEXT_MESSAGE_START` -- assistant message begins
3. `TEXT_MESSAGE_CONTENT` -- streamed text chunks (multiple events)
4. `TEXT_MESSAGE_END` -- assistant message complete
5. If tools are called: `TOOL_CALL_START` -> `TOOL_CALL_ARGS` -> `TOOL_CALL_END`
6. `RUN_FINISHED` -- agent done (or `RUN_ERROR` on failure)

The web UI uses the Vercel AI SDK's `useChat` hook with `DefaultChatTransport`, which handles AG-UI parsing automatically.

### Q: How do I integrate with external systems?

Three integration paths:

1. **Chat API** (`POST /api/v1/workspaces/:id/chat`): Compatible with the Vercel AI SDK `useChat` hook. Send UI messages, receive streaming responses. Best for building custom UIs.

2. **AG-UI streaming** (`POST .../runs/:runId/stream`): Raw SSE event stream. Best for third-party agent clients or custom streaming consumers.

3. **REST API**: Use workspace, thread, and run endpoints to programmatically manage conversations. Create a workspace, start a thread, post runs, and poll for results.

### Q: Can I use RedpointAI without the web UI (API-only)?

Yes. The server (`apps/server`) runs independently. You can interact entirely via the REST and chat APIs:

```bash
# Create a workspace
curl -X POST http://localhost:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"API Bot","provider":{"type":"anthropic","model":"claude-sonnet-4-6"}}'

# Chat with it
curl -X POST http://localhost:3000/api/v1/workspaces/<id>/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"id":"msg-1","role":"user","parts":[{"type":"text","text":"Hello!"}]}]}'
```

The web UI (`apps/web`) is optional and can be deployed separately or not at all.

### Q: What is the SSE event flow for chat?

When you POST to the chat endpoint, the response is an SSE stream. Each event is a JSON object prefixed with `data: `. The full sequence:

```
data: {"type":"RUN_STARTED","runId":"..."}
data: {"type":"TEXT_MESSAGE_START","messageId":"..."}
data: {"type":"TEXT_MESSAGE_CONTENT","content":"Hello"}
data: {"type":"TEXT_MESSAGE_CONTENT","content":" there!"}
data: {"type":"TEXT_MESSAGE_END"}
data: {"type":"RUN_FINISHED","usage":{"inputTokens":150,"outputTokens":25}}
```

If the agent calls a tool:

```
data: {"type":"TOOL_CALL_START","toolCallId":"...","toolName":"rpi__list_audiences"}
data: {"type":"TOOL_CALL_ARGS","args":"{\"limit\":10}"}
data: {"type":"TOOL_CALL_END","result":"..."}
```

---

## 8. Authentication & Security

### Q: How does authentication work?

RedpointAI supports two authentication modes controlled by the `AUTH_REQUIRED` environment variable:

- **`AUTH_REQUIRED=false`** (default): No authentication required. Suitable for local development and testing.
- **`AUTH_REQUIRED=true`**: All API requests must include a valid `Authorization` header with either an OIDC JWT token or a platform API key.

The web UI uses NextAuth with a credentials provider -- users sign in with an API key, which is stored in a JWT session and sent with every chat request.

### Q: What is `AUTH_REQUIRED` and when should I enable it?

Set `AUTH_REQUIRED=true` in any environment where the platform is accessible to multiple users or exposed to a network. This enables the auth middleware on all API endpoints. In local development with a single user, you can leave it as `false` for convenience.

### Q: How are API keys managed?

API keys are managed via the `/api/v1/auth/api-keys` endpoints:

```bash
# Create a key
curl -X POST http://localhost:3000/api/v1/auth/api-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"My Key","workspaceId":"...","permissions":["read","write"],"expiresInDays":90}'
# Returns the raw key (shown only once)

# List keys (without raw values)
curl http://localhost:3000/api/v1/auth/api-keys

# Revoke a key
curl -X DELETE http://localhost:3000/api/v1/auth/api-keys/<keyId>
```

Keys can be scoped to specific workspaces and given read/write permissions with optional expiration.

### Q: How does the JWT session flow work?

1. User enters their API key on the login page (`/login`)
2. NextAuth's credentials provider validates the key by calling `GET /api/v1/providers` with it
3. On success, a JWT is created containing the API key
4. The JWT callback stores the API key in the token
5. The session callback makes the API key available on the session object
6. The chat panel reads `session.apiKey` and includes it as `Authorization: Bearer <key>` on every request

### Q: What is route protection (proxy.ts)?

The `proxy.ts` file (Next.js 16's equivalent of `middleware.ts`) intercepts every request to the web UI. If the user isn't authenticated, it redirects them to `/login`. It allows `/login` and `/api/auth/*` routes through without authentication so the login flow can complete.

### Q: Should my agent use the proxy user or log in as a specific RPI user?

Two options for the *outbound* leg (how the MCP server authenticates to RPI when invoking a tool):

- **Proxy user (`RPI_PROXY_USER`/`RPI_PROXY_PASS`)** — a shared service account the MCP server logs in as once and reuses across all callers. Simple to set up; RPI sees every call as the same identity. Best for system-style automation, scheduled jobs, or agents that don't act on behalf of a specific human.

- **Per-user token (native RPI login)** — the agent logs the end user in via `POST {RPI_INTEGRATION_API_URL}/connect/token` (OAuth2 password grant) and forwards the resulting Bearer token in the `Authorization` header on every `/mcp` request. The MCP server threads it through to RPI, which applies that user's permissions. Best for interactive agents and anywhere RPI's RBAC needs to distinguish callers.

If both are configured, the per-user token wins — the proxy user is fallback only. **Recommendation**: use per-user tokens whenever the agent represents a known end user; reserve the proxy user for system contexts.

For the full walkthrough — login, token forwarding, refresh, logout, error handling, and a runnable TypeScript example — see [`rpi-mcp-server.md`](./rpi-mcp-server.md#authentication).

---

## 9. Troubleshooting

### Q: Chat returns 401 errors -- how do I fix auth issues?

- **If `AUTH_REQUIRED=false`**: 401s shouldn't happen. Check that the environment variable is actually set (restart the server after changes).
- **If `AUTH_REQUIRED=true`**: Ensure your request includes `Authorization: Bearer <key>` header. Verify the API key is valid via `GET /api/v1/auth/api-keys`.
- **In the web UI**: Make sure you're signed in. The chat panel reads the API key from the NextAuth session and sends it automatically. If the session expired, sign in again.
- **OIDC tokens**: Verify `OIDC_JWKS_URI`, `OIDC_ISSUER`, and `OIDC_AUDIENCE` are correct.

### Q: MCP server returns 0 tools -- what's wrong?

This usually means the MCP protocol handshake isn't completing properly. Check:

1. **MCP server is running**: `curl http://localhost:3002/mcp` should respond (not connection refused)
2. **URL is correct**: The workspace config `url` must match the MCP server's address including the `/mcp` path
3. **Accept header**: The MCP HTTP transport requires `Accept: application/json, text/event-stream`
4. **RPI connectivity**: If the MCP server can't reach your RPI instance, tools may fail to register. Check `RPI_INTEGRATION_API_URL` and network access.
5. **Logs**: Run with `LOG_LEVEL=debug` for detailed MCP handshake output

### Q: Provider shows "Not Configured" -- what do I check?

The `/api/v1/providers` endpoint checks for specific environment variables:

- Anthropic: `ANTHROPIC_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- Google: `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY`
- Azure: `AZURE_OPENAI_API_KEY`

Ensure the variable is set correctly (no trailing whitespace, no quotes around the value in `.env`). Restart the server after changing `.env` values.

### Q: Token usage seems high -- how do I optimize?

- **Enable the skill router**: This is the biggest win. Skill-based routing uses ~500 tokens for the catalog vs ~15k for all raw tools.
- **Filter MCP tools per skill**: Use `mcpToolFilter` in SKILL.md to limit each skill to only the tools it needs.
- **Lower `maxSteps`**: Reduce `agent.maxSteps` to limit tool-calling loops (default: 20, try 10-15).
- **Use smaller models for simple tasks**: GPT-4o-mini or Gemini Flash for straightforward queries.
- **Write focused system prompts**: Shorter prompts = fewer input tokens per request.
- **Monitor with metrics**: Track `redpoint_ai_tokens_total` to identify high-consumption patterns.

### Q: How do I read audit logs?

Audit events are logged via the `logAudit` function in `apps/server/src/lib/audit.ts`. Events include:

- `run_start` -- when a chat run begins (includes workspaceId, runId)
- `run_finish` -- when a run completes (includes duration, token usage)
- `error` -- when a run fails (includes error message)
- MCP tool calls are tracked via the `redpoint_ai_mcp_calls_total` metric

Logs go to stdout by default. In production, pipe to your log aggregation service (CloudWatch, Datadog, ELK, etc.) and filter by `action` field.

---

