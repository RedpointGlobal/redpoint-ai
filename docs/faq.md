# RedpointAI FAQ

The comprehensive guide for RPI customers looking to leverage AI and agentic capabilities. If your question isn't answered here, check the other [docs](../README.md#documentation) or open an issue.

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
9. [Deployment & Operations](#9-deployment--operations)
10. [Troubleshooting](#10-troubleshooting)
11. [Best Practices](#11-best-practices)

---

## 1. General / What Is This?

### Q: What is RedpointAI?

RedpointAI is an open-source AI agent platform built for RedPoint Interaction (RPI). It lets you build, compose, and run AI agents that operate against your RPI instance using any LLM provider. The platform exposes RPI capabilities as standard MCP tools, groups them into domain-specific skills, and provides a chat-based UI for natural-language interaction with your marketing data and operations.

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

Five providers are supported out of the box: **Anthropic** (Claude), **OpenAI** (GPT), **Google** (Gemini), **Azure OpenAI**, and **Ollama** (local models). You can use different providers for different workspaces and switch at any time. See [Providers](providers.md) for full details.

### Q: Is this production-ready?

RedpointAI is designed for production use. It includes JWT/OIDC authentication, API key management, Prometheus metrics, audit logging, Docker deployment, and PostgreSQL support. That said, you should review the [Deployment](deployment.md) guide and configure authentication (`AUTH_REQUIRED=true`) before exposing it to production traffic.

---

## 2. Getting Started

### Q: What are the prerequisites?

Depends on which audience you are. The three paths each have a different prereq footprint:

- **Agent developer** (download the binary) — nothing pre-installed; just an MCP client that can speak to `http://localhost:3002/mcp`.
- **Non-tech evaluator** (`docker compose up`) — Docker only. No Bun, no Node.
- **Code contributor** (clone + dev setup) — Bun ≥ 1.3.0, Node ≥ 22.6, an LLM API key, optionally an RPI instance for MCP.

### Q: How do I install and run locally?

Three audiences, three paths — pick yours:

**Agent developer:** Download the per-platform zip from Releases, extract, fill `.env`, double-click the launcher. See [Standalone MCP Server](rpi-mcp-server.md) for details.

**Non-tech evaluator** (zero runtime install beyond Docker):
```bash
git clone https://github.com/RedPointGlobal/redpoint-ai.git
cd redpoint-ai
cp .env.example .env                        # add your LLM key + RPI creds (if applicable)
docker compose up
```
Web UI at http://localhost:3001 once containers are healthy.

**Code contributor** (two commands after the one-time Bun install):
```bash
curl -fsSL https://bun.sh/install | bash    # one-time, if Bun missing
git clone https://github.com/RedPointGlobal/redpoint-ai.git
cd redpoint-ai && bun install && bun run dev
```

`cp .env.example .env` first and add at least `ANTHROPIC_API_KEY`. The server lazy-bootstraps the SQLite schema and seeds default workspaces on first start. See [Getting Started](getting-started.md) for the full contributor walkthrough.

### Q: What environment variables are required?

At minimum, you need one LLM provider API key. Here are the core variables:

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `ANTHROPIC_API_KEY` | -- | Yes* | Anthropic Claude API key |
| `OPENAI_API_KEY` | -- | No | OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | -- | No | Google Gemini API key |
| `PORT` | `3000` | No | Server port |
| `AUTH_REQUIRED` | `false` | No | Enable authentication |
| `AUTH_SECRET` | -- | Prod | JWT signing secret (generate: `openssl rand -base64 32`) |
| `RPI_INTEGRATION_API_URL` | -- | MCP | Your on-premises RPI Integration API URL |
| `RPI_OAUTH_CLIENT_ID` / `RPI_OAUTH_CLIENT_SECRET` | -- | MCP | OAuth2 client credentials for `/connect/token` |
| `RPI_DEFAULT_CLIENT_ID` | -- | MCP | Default value for the `X-ClientID` header (RPI tenant/workspace ID) |
| `RPI_PROXY_USER` / `RPI_PROXY_PASS` | -- | No | Optional native RPI service account fallback |
| `RPI_PROXY_ENABLED` | -- | No | Set `false` to force-disable the proxy user |
| `MCP_HTTP_PORT` | `3002` | No | MCP server HTTP port |
| `DATABASE_URL` | -- | No | PostgreSQL URL (production only; dev uses SQLite) |
| `LOG_LEVEL` | `info` | No | Logging level |

*At least one LLM provider key is required. See the full list in `.env.example`.

### Q: How do I verify the platform is working?

The fastest path is `bun run check` (verifies install invariants — Bun version, lockfile, native bindings, schema apply, env-vars). Optional flag:

```bash
bun run check              # default
bun run check --running    # also curl the three live health endpoints (run after dev / compose up)
```

For a more granular look, hit the underlying endpoints directly:

```bash
# Health check
curl http://localhost:3000/api/v1/health
# Expected: {"status":"ok","version":"0.1.0","runtime":"bun",...}

# List configured providers
curl http://localhost:3000/api/v1/providers
# Expected: array of providers with configured:true

# List workspaces (auto-seeded with the single RedpointAI workspace)
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
MCP_HTTP_PORT=3002
```

Then start the MCP server (`bun run dev:mcp` or included in `bun run dev`). Add an MCP connection to your workspace configuration pointing to `http://localhost:3002/mcp`. The MCP server will fail to start if `RPI_INTEGRATION_API_URL`, `RPI_OAUTH_CLIENT_ID`, `RPI_OAUTH_CLIENT_SECRET`, or `RPI_DEFAULT_CLIENT_ID` is not set. Callers authenticate via Bearer token (native RPI or OIDC); the optional proxy user is used as a fallback when no per-user token is present — set `RPI_PROXY_ENABLED=false` to force-disable it.

### Q: What does the default workspace include?

On first run, the server auto-seeds a single workspace: **RedpointAI** (Azure GPT-4.1 with the RPI domain skills enabled). When you create a new workspace, you choose a name, provider/model, and optionally attach MCP servers and skills. The default agent configuration uses the system prompt "You are a helpful assistant." with a max of 20 tool-calling steps. You can also load a pre-built template:

```bash
curl -X POST http://localhost:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d @skills/templates/marketing-ops.json
```

Available templates in `skills/templates/`: `marketing-ops.json`, `customer-insights.json`, `content-manager.json`, `rpi-admin.json`.

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
| `provider.apiKey` | No | Override server-level API key |
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

Workspace settings override global defaults. For example, if you set `ANTHROPIC_API_KEY` in your `.env` file, all workspaces using the `anthropic` provider type will use that key unless the workspace specifies its own `provider.apiKey`. Similarly, the default system prompt is used unless the workspace provides its own `agent.systemPrompt`.

---

## 4. LLM Providers / BYOM

### Q: What does BYOM (Bring Your Own Model) mean?

BYOM means you choose which LLM provider and model powers each workspace. RedpointAI doesn't lock you into a single provider -- you can use Anthropic for one workspace and OpenAI for another, or switch providers at any time by updating the workspace configuration.

### Q: Which providers are supported?

| Provider | Env Variable | Example Models |
|----------|-------------|----------------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `o1`, `o3-mini` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_RESOURCE_NAME` | Your Azure deployment models |
| Ollama | *(none -- runs locally)* | Any model pulled locally (`llama3.1`, `mistral`, etc.) |


See [Providers](providers.md) for setup instructions for each.

### Q: How do I configure a provider?

1. Set the API key in your `.env` file (e.g., `ANTHROPIC_API_KEY=sk-ant-...`)
2. When creating a workspace, specify the provider type and model:

```json
{
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-6"
  }
}
```

For Ollama (local models), no API key is needed -- just set the base URL:

```json
{
  "provider": {
    "type": "ollama",
    "model": "llama3.1",
    "baseUrl": "http://localhost:11434"
  }
}
```

### Q: Can I use different providers for different workspaces?

Yes. Each workspace has its own `provider` configuration. You could run marketing ops on Claude (strong tool-calling), customer insights on GPT-4o, and a dev/test workspace on a local Ollama model -- all simultaneously.

### Q: How do I check which providers are configured?

```bash
curl http://localhost:3000/api/v1/providers
```

Returns an array of providers showing which ones have API keys configured and their available models.

### Q: What are the recommended models for different use cases?

- **Complex multi-step agent workflows** (tool-calling, skill routing): Anthropic Claude Sonnet or Opus -- best-in-class tool-calling reliability
- **Simple Q&A or expert skills**: Any provider works well; GPT-4o and Gemini 2.5 Flash are cost-effective
- **Local/air-gapped deployments**: Ollama with Llama 3.1 or Mistral
- **Enterprise compliance requirements**: Azure OpenAI (data stays in your cloud)

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

Skills come in two roles: **action skills** define the *how* (each wraps one RPI domain's MCP tools), and **expert skills** define the *what* (domain knowledge, no tools). RedpointAI ships six action skills and two experts.

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
MCP_HTTP_PORT=3002
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
- **Connection refused**: Check `MCP_HTTP_PORT` matches the server's port and the URL in workspace config
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

### Q: What security best practices should I follow?

- Always set `AUTH_REQUIRED=true` in production
- Use OIDC/JWT for enterprise SSO integration:
  ```env
  OIDC_JWKS_URI=https://your-idp/.well-known/jwks.json
  OIDC_ISSUER=https://your-idp
  OIDC_AUDIENCE=redpoint-ai
  ```
- Rotate API keys regularly and set expiration dates
- Use workspace-scoped API keys with minimum necessary permissions
- Keep LLM provider API keys in environment variables, never in workspace configs stored in the database
- Review audit logs (`logAudit`) for unexpected activity
- Use HTTPS in production (terminate TLS at your load balancer/reverse proxy)

### Q: Should my agent use the proxy user or log in as a specific RPI user?

Two options for the *outbound* leg (how the MCP server authenticates to RPI when invoking a tool):

- **Proxy user (`RPI_PROXY_USER`/`RPI_PROXY_PASS`)** — a shared service account the MCP server logs in as once and reuses across all callers. Simple to set up; RPI sees every call as the same identity. Best for system-style automation, scheduled jobs, or agents that don't act on behalf of a specific human.

- **Per-user token (native RPI login)** — the agent logs the end user in via `POST {RPI_INTEGRATION_API_URL}/connect/token` (OAuth2 password grant) and forwards the resulting Bearer token in the `Authorization` header on every `/mcp` request. The MCP server threads it through to RPI, which applies that user's permissions. Best for interactive agents and anywhere RPI's RBAC needs to distinguish callers.

If both are configured, the per-user token wins — the proxy user is fallback only. **Recommendation**: use per-user tokens whenever the agent represents a known end user; reserve the proxy user for system contexts.

For the full walkthrough — login, token forwarding, refresh, logout, error handling, and a runnable TypeScript example — see [`rpi-mcp-server.md`](./rpi-mcp-server.md#authentication).

---

## 9. Deployment & Operations

### Q: How do I deploy with Docker?

```bash
cp .env.example .env
# Edit .env with your API keys and configuration

# Development (SQLite)
docker compose up

# Production (with PostgreSQL)
docker compose --profile production up
```

The Docker setup includes three services: API server (port 3000), web UI (port 3001), and MCP server (port 3002). The production profile adds PostgreSQL.

### Q: What are the Docker images and how do they relate?

| Image | Dockerfile | Base | Purpose |
|-------|-----------|------|---------|
| `server` | `apps/server/Dockerfile` | `oven/bun:1` | API server with agent engine |
| `web` | `apps/web/Dockerfile` | `oven/bun:1` (build) / `node:22-alpine` (run) | Next.js frontend (standalone output) |
| `mcp-rpi` | `packages/mcp-rpi/Dockerfile` | `oven/bun:1` | RPI MCP server |

The server image includes native build tools (python3, make, g++) for `better-sqlite3`. The web image uses a multi-stage build: Bun for building, Node.js Alpine for the slim production runtime.

### Q: How do I configure environment variables in production?

Pass environment variables to your containers via:

- Docker Compose `.env` file
- Docker `--env-file` flag
- Kubernetes ConfigMaps/Secrets
- Cloud platform environment configuration (ECS, Cloud Run, etc.)

Key production variables:

```env
AUTH_REQUIRED=true
DATABASE_URL=postgres://<user>:<pass>@example.com:5432/redpoint_ai
ANTHROPIC_API_KEY=sk-ant-...
RPI_INTEGRATION_API_URL=https://rpi.your-company.com
RPI_OAUTH_CLIENT_ID=your-oauth-client-id
RPI_OAUTH_CLIENT_SECRET=your-oauth-client-secret
RPI_DEFAULT_CLIENT_ID=your-rpi-tenant-id
OIDC_JWKS_URI=https://your-idp/.well-known/jwks.json
OIDC_ISSUER=https://your-idp
OIDC_AUDIENCE=redpoint-ai
```

### Q: What metrics are available?

The `/metrics` endpoint exposes Prometheus-format metrics:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `redpoint_ai_runs_total` | Counter | `status`, `provider` | Total completed runs |
| `redpoint_ai_tokens_total` | Counter | `type` (input/output) | Total tokens consumed |
| `redpoint_ai_run_duration_seconds` | Histogram | -- | Run duration (buckets: 0.5s to 60s) |
| `redpoint_ai_mcp_calls_total` | Counter | `server`, `tool` | MCP tool invocations |
| `redpoint_ai_active_sessions` | Gauge | -- | Currently active chat sessions |

Scrape with Prometheus, Datadog, or any compatible monitoring tool.

### Q: How do I monitor active sessions and token usage?

Query the metrics endpoint:

```bash
curl http://localhost:3000/metrics
```

Key things to watch:

- **`redpoint_ai_active_sessions`**: Current concurrent sessions (gauge). If this only goes up, check for session leak bugs.
- **`redpoint_ai_tokens_total{type="input"}`** and `{type="output"}`: Track input/output token consumption for cost monitoring.
- **`redpoint_ai_runs_total{status="failed"}`**: Failed run count -- alert if this spikes.
- **`redpoint_ai_run_duration_seconds`**: P50/P95 latency via histogram buckets.

### Q: What is the recommended production architecture?

```
                    Load Balancer (HTTPS)
                    /        |         \
              Web (3001)  Server (3000)  MCP (3002)
                              |              |
                         PostgreSQL      RPI Instance
```

- **Load balancer**: Terminates TLS, routes traffic to services
- **Server**: Stateless, horizontally scalable (connect all instances to same PostgreSQL)
- **Web**: Stateless Next.js frontend (can run multiple instances)
- **MCP**: Runs alongside server or as separate service (one per RPI instance)
- **PostgreSQL**: Required for multi-instance deployments (replaces SQLite)

### Q: How do I scale the platform?

The server is stateless (state lives in the database), so you can scale horizontally:

1. Switch from SQLite to PostgreSQL (`DATABASE_URL`)
2. Run multiple server instances behind a load balancer
3. Run MCP servers as separate containers (one per RPI instance if needed)
4. Mount the `skills/` directory as a shared volume or bake skills into the Docker image
5. Skills are loaded once on startup -- restart servers to pick up new skills

---

## 10. Troubleshooting

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

### Q: Docker build fails -- common causes?

- **Lockfile errors**: Don't use `--frozen-lockfile` in Dockerfiles; bun workspace symlinks don't survive `COPY`
- **Native compilation failures** (better-sqlite3): The server Dockerfile needs `python3`, `make`, and `g++` installed
- **`next: command not found`**: The Next.js binary lives in the workspace-level `node_modules`, not the root. The web Dockerfile uses `./node_modules/.bin/next build`
- **Build context too large**: Ensure `.dockerignore` excludes `node_modules`, `.next`, `.git`, `*.db`, and `.env`
- **TypeScript errors**: Run `bun run build` locally first to catch type errors before building Docker images

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

## 11. Best Practices

### Q: How should I structure system prompts for best results?

- **Be specific about the role**: "You are a marketing operations specialist for an e-commerce company" beats "You are helpful"
- **List capabilities explicitly**: Tell the agent what it can do and which skills/tools are available
- **Set behavioral guidelines**: "Always confirm before executing workflows", "Provide context alongside raw data"
- **Keep it concise**: Every token in the system prompt is sent with every request -- aim for 200-500 words
- **Use markdown formatting**: Headings and bullet points help the LLM parse instructions
- **Test iteratively**: Start simple, observe agent behavior, and refine

### Q: What's the best approach for multi-step RPI workflows?

Combine an **expert skill** (the *what*) with **action skills** (the *how*), each with a focused `mcpToolFilter`. For example, an interaction launch workflow might:

1. Consult `rpi-foundation-expert` for RPI conventions and terminology (expert skill, no tools)
2. Use `rpi-audiences` to inspect the target audience, then `rpi-interactions` to activate and run the interaction workflow (action skills, with tools)
3. Check the workflow instance status via `rpi-interactions`

The skill router handles this naturally -- the agent consults experts for advice, then delegates execution to action skills. Set `maxSteps` high enough (15-25) for multi-tool sequences.

### Q: How do I test skills before deploying?

1. **Local testing**: Run `bun run dev` and create a test workspace with the skill enabled
2. **API testing**: Use curl to send test messages and observe the streaming response
3. **Unit tests**: Add tests in the skill package (`bun run test:skills`)
4. **Dry-run mode**: For action skills, add "describe what you would do without executing" to your test prompt
5. **Check skill loading**: The server logs which skills are loaded on startup -- verify your skill appears

### Q: How should I handle sensitive customer data?

- **LLM provider data policies**: Understand your provider's data retention and usage policies. For maximum control, use Azure OpenAI (data stays in your cloud) or Ollama (fully local).
- **System prompt guardrails**: Include instructions like "Never include PII in your responses" or "Summarize customer data without exposing individual records"
- **Workspace-scoped access**: Use separate workspaces with different API keys for different access levels
- **Tool filtering**: Three axes available — `mcpToolFilter` in a SKILL.md frontmatter narrows per sub-agent; `allowedTools` on an MCP connection narrows per workspace and is forwarded to the MCP server as a `names` filter on `tools/list`; `category` on `tools/list` coarsely narrows by tool domain (e.g. `audiences`, `interactions`). See `docs/rpi-mcp-server.md#tool-filtering` for the wire format.
- **Audit everything**: Enable audit logging and monitor for unexpected data access patterns
- **Network isolation**: Run MCP servers in the same network as RPI to avoid data traversing public networks

### Q: What are the recommended patterns for production use?

1. **One workspace per use case**: Don't overload a single workspace with too many skills. Create focused agents.
2. **Enable auth**: `AUTH_REQUIRED=true` with OIDC or API keys. Always.
3. **Use PostgreSQL**: SQLite is great for development but doesn't support concurrent access from multiple server instances.
4. **Monitor metrics**: Set up Prometheus scraping and alerts on `active_sessions`, `runs_total{status="failed"}`, and token consumption.
5. **Pin model versions**: Use specific dated model versions (e.g., `claude-haiku-4-5-20251001`) rather than aliases to avoid unexpected behavior changes — where a dated form exists; some current models (e.g., `claude-sonnet-4-6`, `claude-opus-4-7`) ship alias-only and have no dated variant.
6. **Start with expert skills**: Let users get comfortable with knowledge-based interactions before enabling action skills that modify RPI data.
7. **Review tool access**: Audit which tools each skill can access. The principle of least privilege applies to AI agents too.
