# API Reference

Base URL: `http://localhost:3000/api/v1`

All endpoints return JSON unless otherwise noted. When `AUTH_REQUIRED=true`, requests must include either a Bearer token (OIDC JWT) or an API key in the `Authorization` header.

## Health

### `GET /health`

```json
{
  "status": "ok",
  "version": "0.1.0",
  "runtime": "bun",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

## Workspaces

### `GET /api/v1/workspaces`

List all workspaces.

### `GET /api/v1/workspaces/:id`

Get a workspace by ID. Returns 404 if not found.

### `POST /api/v1/workspaces`

Create a workspace. Body validated against `WorkspaceCreateSchema`:

```json
{
  "name": "My Agent",
  "description": "Optional description",
  "provider": { "type": "anthropic", "model": "claude-sonnet-4-6" },
  "agent": { "systemPrompt": "You are...", "maxSteps": 20 },
  "mcp": [{ "name": "rpi", "transport": "http", "url": "http://localhost:3002/mcp" }],
  "skills": ["rpi-audiences", "rpi-foundation-expert"],
  "suggestions": ["Show me all audiences"]
}
```

Returns 201 with the created workspace including `id`, `createdAt`, `updatedAt`.

### `PUT /api/v1/workspaces/:id`

Update a workspace. Accepts the same body as POST.

### `DELETE /api/v1/workspaces/:id`

Delete a workspace. Returns `{ "deleted": true }`.

## Threads

Threads are scoped to a workspace: `/api/v1/workspaces/:workspaceId/threads`.

### `GET .../threads`

List threads for a workspace, ordered by most recently updated.

### `POST .../threads`

Create a thread. Optional body: `{ "title": "My Thread" }`. Returns 201.

### `GET .../threads/:threadId`

Get a thread with its messages array.

### `DELETE .../threads/:threadId`

Delete a thread and its messages/runs.

## Runs

Runs are scoped to a thread: `.../threads/:threadId/runs`.

### `POST .../threads/:threadId/runs`

Create a run with a user message:

```json
{ "message": "How many VIP customers do we have?" }
```

Returns 201 with `{ run, userMessage }`.

### `GET .../threads/:threadId/runs`

List runs for a thread, ordered by most recent.

## Chat (useChat)

### `POST /api/v1/workspaces/:workspaceId/chat`

Primary chat endpoint compatible with the Vercel AI SDK `useChat` hook. Accepts UI messages and returns a streaming response.

Request body:

```json
{
  "messages": [
    { "id": "msg-1", "role": "user", "parts": [{ "type": "text", "text": "Hello" }] }
  ]
}
```

Response: SSE stream of UI message events (AG-UI protocol).

## AG-UI Streaming

### `POST /api/v1/workspaces/:workspaceId/threads/:threadId/runs/:runId/stream`

Raw AG-UI event stream for third-party agent clients. Emits granular events:

- `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`
- `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`
- `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`

Response: `text/event-stream` (SSE).

## Providers

### `GET /api/v1/providers`

Returns available providers (those with API keys configured):

```json
[
  { "id": "anthropic", "name": "Anthropic", "models": ["claude-sonnet-4-6"] },
  { "id": "openai", "name": "OpenAI", "models": ["gpt-4o"] }
]
```

## Auth

### `POST /api/v1/auth/api-keys`

Create an API key:

```json
{
  "name": "My Key",
  "workspaceId": "uuid",
  "permissions": ["read", "write"],
  "expiresInDays": 90
}
```

Returns 201 with the raw key (shown only once).

### `GET /api/v1/auth/api-keys`

List API keys (without raw values).

### `DELETE /api/v1/auth/api-keys/:keyId`

Revoke an API key.

## Metrics

### `GET /metrics`

> **Note:** This endpoint is at the root path, not under `/api/v1`.

Prometheus-format metrics:

- `redpoint_ai_runs_total` — completed runs by status and provider
- `redpoint_ai_tokens_total` — tokens consumed by type (input/output)
- `redpoint_ai_run_duration_seconds` — run duration histogram
- `redpoint_ai_mcp_calls_total` — MCP tool calls by server and tool
- `redpoint_ai_active_sessions` — currently active chat sessions
