# Workspaces

A workspace is an isolated agent environment with its own model configuration, system prompt, MCP connections, skills, and suggested prompts.

## Configuration Structure

```json
{
  "name": "Marketing Operations",
  "description": "Full-service marketing ops agent",
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": "sk-ant-...",
    "baseUrl": "https://custom-endpoint.example.com"
  },
  "agent": {
    "systemPrompt": "You are a marketing operations specialist...",
    "maxSteps": 25
  },
  "mcp": [
    {
      "name": "rpi",
      "transport": "http",
      "url": "http://localhost:3002/mcp"
    }
  ],
  "skills": ["rpi-audiences", "rpi-foundation-expert"],
  "suggestions": [
    "Show me all active audiences",
    "Run the monthly performance report"
  ]
}
```

## Fields

### `provider` (required)

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"openai" \| "anthropic" \| "google" \| "ollama" \| "azure-openai"` | LLM provider |
| `model` | `string` | Model identifier (e.g., `claude-sonnet-4-6`, `gpt-4o`) |
| `apiKey` | `string?` | Override the server-level API key |
| `baseUrl` | `string?` | Custom endpoint URL |
| `azureDeployment` | `string?` | Azure OpenAI deployment name |

### `agent` (optional)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `systemPrompt` | `string` | `"You are a helpful assistant."` | Agent instructions |
| `maxSteps` | `number` | `20` | Max tool-calling iterations (1-100) |

### `mcp` (optional)

Array of MCP server connections. Each entry:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Connection identifier |
| `transport` | `"http" \| "stdio"` | Transport type |
| `url` | `string?` | HTTP endpoint (for `http` transport) |
| `command` | `string?` | Executable path (for `stdio` transport) |
| `args` | `string[]?` | Command arguments (for `stdio` transport) |
| `env` | `Record<string, string>?` | Environment variables |
| `allowedTools` | `string[]?` | Restrict to specific tools |

### `skills` (optional)

Array of skill names to enable. Skills must be registered in the `skills/` directory. When skills are configured, expert skills are inlined directly into the system prompt as domain knowledge, while action/hybrid skills are available via the `execute_skill` meta-tool. If omitted or empty, all registered skills are loaded.

### `suggestions` (optional)

Array of starter prompt strings displayed in the chat UI to help users get started.

## API

All endpoints are under `/api/v1/workspaces`.

### List workspaces

```
GET /api/v1/workspaces
```

Returns an array of all workspaces.

### Get workspace

```
GET /api/v1/workspaces/:id
```

Returns a single workspace by ID. Returns 404 if not found.

### Create workspace

```
POST /api/v1/workspaces
Content-Type: application/json

{ ...workspace config... }
```

Body is validated against `WorkspaceCreateSchema`. Returns 201 with the created workspace.

### Update workspace

```
PUT /api/v1/workspaces/:id
Content-Type: application/json

{ ...updated fields... }
```

### Delete workspace

```
DELETE /api/v1/workspaces/:id
```

Returns `{ "deleted": true }` on success.

## Templates

Pre-built workspace configs are available in `skills/templates/`:

- `marketing-ops.json` — hybrid marketing operations agent
- `customer-insights.json` — analytics and segmentation expert
- `content-manager.json` — content and template management
- `rpi-admin.json` — system monitoring and administration

Import a template:

```bash
curl -X POST http://localhost:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d @skills/templates/marketing-ops.json
```
