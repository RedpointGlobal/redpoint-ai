# Providers

RedpointAI is BYOM (Bring Your Own Model) -- it supports multiple LLM providers and allows runtime switching per workspace.

## Supported Providers

### Anthropic

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Models: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`

Recommended as the default provider. Best tool-calling performance for complex agent workflows.

### OpenAI

```env
OPENAI_API_KEY=sk-...
```

Models: `gpt-5`, `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `o1`, `o3-mini`

### Google

```env
GOOGLE_GENERATIVE_AI_API_KEY=...
```

Models: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`

### Azure OpenAI

```env
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_RESOURCE_NAME=your-resource-name
AZURE_OPENAI_API_VERSION=2024-10-01-preview
```

The resource name is used to build the endpoint URL (`https://{resourceName}.openai.azure.com`). RedpointAI uses the Chat Completions API (`azureProvider.chat()`), not the Responses API. The default API version is `2024-10-01-preview`. The `model` field in workspace config is used as the deployment name. Use `azureDeployment` to override if the deployment name differs from the model name.

Deployments: `gpt-4.1`, `gpt-5`, `gpt-5-mini`, `gpt-4o`, `gpt-4o-mini`. **Each deployment id is its own per-minute TPM bucket** — a shared/contended deployment can 429 even when a peer deployment sits idle, so routing a workspace at a less-contended peer is a config change, not a model downgrade. The seeded **RedpointAI default is `gpt-4.1`** (a 100K-TPM bucket; the shared `gpt-4o` deployment is ~10K and was the source of earlier 429/latency). gpt-5* deployments are reasoning models (higher latency — wrong tool for routing-bound workloads).

### Ollama

No API key required -- runs locally.

```env
# No env vars needed; set baseUrl in workspace config
```

Configure the workspace provider with:

```json
{
  "type": "ollama",
  "model": "llama3.1",
  "baseUrl": "http://localhost:11434"
}
```

Models: any model pulled into your local Ollama instance.

## Workspace Provider Config

Each workspace specifies its own provider, enabling different agents to use different models:

```json
{
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "baseUrl": "https://custom-proxy.example.com"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Provider identifier |
| `model` | Yes | Model name |
| `apiKey` | No | `${ENV_VAR}` reference only; a literal key is rejected by the schema |
| `baseUrl` | No | Custom API endpoint |
| `azureDeployment` | No | Azure OpenAI deployment name |

## Choosing a provider

The provider is derived from the environment at boot and written into the seeded
workspaces: `pickDefaultProvider()` picks Azure, then Anthropic, then OpenAI, by
which API key is present. Model and deployment follow
`AZURE_OPENAI_DEPLOYMENT_ID` / `AZURE_OPENAI_MODEL` / `ANTHROPIC_MODEL` /
`OPENAI_MODEL`, falling back to the shipped defaults.

**Edit `.env` (or the key vault, when hosted) and restart — that is the switch.**
The seed rewrites workspace config on every boot, so a provider changed through
`PUT /api/v1/workspaces/:id` is reverted on the next restart; that endpoint is
not the way to change models.

## Available Providers API

```
GET /api/v1/providers
```

Returns the list of providers that have API keys configured on the server, helping the frontend show which options are available.
