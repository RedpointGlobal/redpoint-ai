# API Reference

Base URL: `http://localhost:3000/api/v1`

All endpoints return JSON unless otherwise noted. When `AUTH_REQUIRED=true`, requests must include either a Bearer token (OIDC JWT) or an API key in the `Authorization` header.

## Limits

Every `/api/v1` call is bounded. Over a limit the answer is `429` with `Retry-After` (seconds); the limits are constants of the product, not configuration.

| Bound | Limit | Applies |
|---|---|---|
| Requests per peer address | 1200 / minute | always (a flood ceiling, before auth) |
| RPI token validations (new tokens) | 600 / minute, server-wide | always; a cached token costs nothing, so signed-in users keep working while new tokens are refused |
| Failed validations of one token | 10 / minute | always |
| Requests per user | 120 / minute | auth on |
| Chat turns per user (`/chat`, the AG-UI stream, an A2A message) | 20 / minute | auth on |
| Open trace streams per user | 5 | auth on |
| API keys minted per user | 10 / hour | auth on |
| Request body | 4 MiB (`413` over it) | always |

With `AUTH_REQUIRED=false` (the local dev run, one operator) the per-user limits do not apply.

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

**Dev mode only** (`AUTH_REQUIRED=false`): with auth on, `POST`, `PUT` and `DELETE` on workspaces answer `403` for every caller. The workspaces are shared by every user and their configuration decides where each user's token goes, so no user may change it; the seeded workspaces come from code.

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

Threads are scoped to a workspace: `/api/v1/workspaces/:workspaceId/threads`, and each belongs to the identity that created it (an API key acts as its owner). Every thread route — and the runs and the AG-UI stream on it — answers `404` for a thread the caller doesn't own, one under another workspace's id, or one created before 7.179 (no owner; dev mode sees all).

### `GET .../threads`

List the caller's threads in a workspace, ordered by most recently updated.

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

## Trace

### `GET /api/v1/workspaces/:id/trace` · `GET /api/v1/workspaces/:id/trace/stream`

The caller's own telemetry events in the workspace (each tool call's arguments and result) — never another user's: the buffer is kept per workspace and user. `?clear=1` clears the caller's own events. `/trace/stream` (SSE) replays them, then follows the caller's new ones.

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
  "expiresInDays": 90
}
```

Returns 201 with the raw key (shown only once). The key belongs to the caller and acts **as** them: it reaches their own threads and trace, and, when `workspaceId` is set, only that workspace (any other answers `404`). Only a non-key caller may create one (`403` for an API key). Every key expires: `expiresInDays` defaults to 90, 365 at most. (The former `permissions` field was never enforced and is now refused.)

### `GET /api/v1/auth/api-keys`

List the caller's own API keys (without raw values).

### `DELETE /api/v1/auth/api-keys/:keyId`

Revoke one of the caller's own API keys (another's: `404`).

## Metrics

### `GET /metrics`

> **Note:** This endpoint is at the root path, not under `/api/v1`.

Prometheus-format metrics:

- `redpoint_ai_runs_total` — completed runs by status and provider
- `redpoint_ai_tokens_total` — tokens consumed by type (input/output)
- `redpoint_ai_run_duration_seconds` — run duration histogram
- `redpoint_ai_mcp_calls_total` — MCP tool calls by server and tool
- `redpoint_ai_active_sessions` — currently active chat sessions
