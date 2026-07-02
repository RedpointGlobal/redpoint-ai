# Deployment

## Docker Compose

The quickest way to deploy all services:

```bash
cp .env.example .env
# Edit .env with your API keys

# Development (SQLite)
docker compose up

# Production (with PostgreSQL)
docker compose --profile production up
```

After the stack is up, validate end-to-end with:

```bash
bun run check --running
```

Curls the three default health endpoints (`server`, `web`, `mcp-rpi`) plus the underlying install invariants. Returns exit 0 if everything's serving.

### Services

| Service | Port | Description |
|---------|------|-------------|
| `server` | 3000 | Bun + Hono API server |
| `web` | 3001 | Next.js frontend |
| `mcp-rpi` | 3002 | RPI MCP server |
| `postgres` | 5432 | PostgreSQL (production profile only) |

## Production Configuration

### Database

Switch from SQLite to PostgreSQL by setting `DATABASE_URL`:

```env
DATABASE_URL=postgres://redpoint:password@localhost:5432/redpoint_ai
```

Run migrations:

```bash
bunx drizzle-kit push
```

### Authentication

Enable auth for production:

```env
AUTH_REQUIRED=true
```

Configure OIDC for JWT validation:

```env
OIDC_JWKS_URI=https://your-idp/.well-known/jwks.json
OIDC_ISSUER=https://your-idp
OIDC_AUDIENCE=redpoint-ai
```

Or use API key authentication (keys managed via the `/api/v1/auth/api-keys` endpoint).

### RPI Connection

Point the MCP server at your on-premises RPI instance:

```env
RPI_INTEGRATION_API_URL=https://rpi.your-company.com
RPI_OAUTH_CLIENT_ID=your-oauth-client-id
RPI_OAUTH_CLIENT_SECRET=your-oauth-client-secret
RPI_DEFAULT_CLIENT_ID=your-rpi-tenant-id
# Optional proxy user (native RPI service account fallback)
RPI_PROXY_USER=your-service-account
RPI_PROXY_PASS=your-service-account-password
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | — | Anthropic API key |
| `OPENAI_API_KEY` | No | — | OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | — | Google AI API key |
| `AZURE_OPENAI_API_KEY` | No | — | Azure OpenAI API key |
| `PORT` | No | `3000` | Server port |
| `AUTH_REQUIRED` | No | `false` | Enable authentication |
| `AUTH_SECRET` | Prod | — | NextAuth JWT signing secret (`openssl rand -base64 32`) |
| `OIDC_JWKS_URI` | No | — | OIDC JWKS endpoint |
| `OIDC_ISSUER` | No | — | OIDC issuer URL |
| `OIDC_AUDIENCE` | No | — | OIDC audience claim |
| `RPI_INTEGRATION_API_URL` | MCP | — | Your on-premises RPI Integration API root URL |
| `RPI_OAUTH_CLIENT_ID` | MCP | — | OAuth2 client ID for `/connect/token` |
| `RPI_OAUTH_CLIENT_SECRET` | MCP | — | OAuth2 client secret |
| `RPI_DEFAULT_CLIENT_ID` | MCP | — | Default value for the `X-ClientID` header (RPI tenant/workspace ID) |
| `RPI_PROXY_USER` | No | — | Native RPI service account username (enables proxy user) |
| `RPI_PROXY_PASS` | No | — | Native RPI service account password (enables proxy user) |
| `RPI_PROXY_ENABLED` | No | — | `false` force-disables the proxy user (creds ignored) |
| `MCP_HTTP_PORT` | No | `3002` | MCP HTTP server port |
| `DATABASE_URL` | No | — | PostgreSQL connection string |
| `LOG_LEVEL` | No | `info` | Logging level |

*At least one LLM provider API key is required.

## Scaling Considerations

- The server is stateless (aside from the database) and can be horizontally scaled
- MCP servers can run as separate processes or containers
- Use PostgreSQL for multi-instance deployments
- Skills are loaded from disk on startup -- mount the `skills/` directory as a volume for dynamic updates
