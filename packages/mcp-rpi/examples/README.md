# mcp-rpi examples

Self-contained, runnable scripts that demonstrate how an AI agent integrates with the MCP RPI server. Each script is intentionally pedagogical — small, well-commented, and copy-pasteable into your own agent.

## agent-auth-flow.ts

End-to-end per-user authentication: log in to RPI as a specific native user, call an MCP tool with that user's token, refresh the token, log out.

### Why per-user instead of the proxy user?

The MCP server can be configured with `RPI_PROXY_USER`/`RPI_PROXY_PASS` — a shared service account it falls back on when no inbound user token is present. That's fine for system-style automation, but RPI then sees every call as the proxy user, so its RBAC can't distinguish between agent runs.

When the agent represents a known end user, log in as that user and forward the resulting Bearer token. RPI then enforces *that user's* permissions on every API call. If both the proxy user and a per-user token are configured, the per-user token wins.

See `docs/rpi-mcp-server.md#authentication` for the full walkthrough.

### Run

```bash
bun run packages/mcp-rpi/examples/agent-auth-flow.ts
```

### Required env

| Var | Description |
|-----|-------------|
| `RPI_INTEGRATION_API_URL` | Root URL of the RPI Integration API (no `/api/v2` suffix) |
| `RPI_OAUTH_CLIENT_ID` | OAuth2 client ID for `/connect/token` |
| `RPI_OAUTH_CLIENT_SECRET` | OAuth2 client secret |
| `RPI_USERNAME` | Native RPI username to log in as |
| `RPI_PASSWORD` | That user's password |

### Optional env

| Var | Default | Description |
|-----|---------|-------------|
| `MCP_HTTP_URL` | `http://localhost:3002/mcp` | MCP server endpoint |

### Pre-flight

The MCP server must be running and reachable at `MCP_HTTP_URL`. To prove the user token (not the proxy user) is the one being forwarded to RPI, start the MCP server with `RPI_PROXY_ENABLED=false` — any tool call that fails to forward the user token will then fail loudly instead of silently using the proxy.

### Expected output

Five steps: login → MCP tool call → refresh → MCP tool call again → logout. Each step prints a short status line. The `verify_connection` tool result is summarized as `userTokenPresent`, `proxyEnabled`, and `apiCallSuccess` flags — `userTokenPresent=true, proxyEnabled=false, apiCallSuccess=true` is the success shape.
