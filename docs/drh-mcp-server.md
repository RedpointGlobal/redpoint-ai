# DRH MCP Server

An MCP server for the Data Readiness Hub (DRH) OP-ServicesAPI. It runs over Streamable HTTP at `/mcp` (port 3003) with a `/health` endpoint. Source lives in `packages/mcp-drh`; it ships as a per-platform binary with a click-to-run launcher.

## Tool Domains

| Domain | File (`packages/mcp-drh/src/`) | Examples |
|---|---|---|
| Databases | `tools/databases.ts` | `drh_list_databases`, `drh_get_default_database` |
| Sources | `tools/sources.ts` | `drh_list_sources`, `drh_get_source_by_id` |
| Feeds | `tools/feeds.ts` | `drh_list_feeds`, `drh_get_feed_columns` |
| Runs | `tools/runs.ts` | `drh_list_feed_runs`, `drh_get_feed_run_record_metrics` |
| Data quality | `tools/data-qualities.ts` | `drh_get_data_quality` |
| Subject areas | `tools/subject-areas.ts` | `drh_list_subject_areas` |
| Schedules | `tools/schedules.ts` | `drh_list_schedules`, `drh_calculate_schedule_times` |
| Aggregations | `tools/aggs.ts` | `drh_list_aggs_schedules` |
| Automation logs | `tools/automation-logs.ts` | `drh_search_automation_logs` |
| Dashboard | `tools/ui-dashboard.ts` | `drh_get_database_summary` |
| Connection | `tools/auth.ts` | `drh_verify_connection` |

93 tools register; the 36 that declare themselves writes (`annotations.readOnlyHint === false`) are disabled, so the server lists 57 (`packages/mcp-drh/src/tool-surface.ts`). To allow one, add its name to `WRITE_TOOLS_ALLOWED` in `packages/mcp-drh/src/server.ts` and rebuild. With no backend configured (`DRH_API_URL` or `DRH_DEFAULT_CLIENT_ID` unset) the server lists no tools and `/health` reports `"mcp":"degraded"` with the missing names.

## Configuration

The env contract is `packages/mcp-drh/scripts/binary-env.ts`; the binary zip's `.env.example` is rendered from it.

| Variable | Required | Meaning |
|---|---|---|
| `DRH_API_URL` | yes | Root URL of the OP-ServicesAPI (no path suffix) |
| `DRH_DEFAULT_CLIENT_ID` | yes | The tenant, sent as `X-ClientId` on every call. A tool's `clientId` argument overrides it per call. |
| `DRH_PROXY_USER` / `DRH_PROXY_PASS` | in env-credential mode | The DRH account calls run as (Keycloak sign-on) |
| `AUTH_REQUIRED` | | `false` = env-credential mode; anything else = token mode (the default), which requires `DRH_PIN_CLIENT_ID=true` |
| `DRH_PIN_CLIENT_ID` | in token mode | `true` = one tenant: a per-call `clientId` that differs from `DRH_DEFAULT_CLIENT_ID` is refused, and callers' tokens are checked for that tenant |
| `DRH_DEFAULT_DATABASE_ID` | | The database used when a database tool names none (else the tenant's default database) |
| `DRH_PROXY_ENABLED` | | `false` switches the account off; unset = on when user + password are set |
| `DRH_TOKEN_TTL_SECONDS` | | How long the account's sign-on token is reused when the sign-on reply has no `expiresAfter` (default 300) |
| `DRH_MCP_HTTP_PORT` | | The HTTP port (default 3003) |
| `DRH_CORS_ORIGINS` | | Comma-separated web origins allowed by CORS (default `http://localhost:3000,http://localhost:3001`; never a wildcard) |

Under `bun run dev` the server fills any unset key from the repo-root `.env`; a compiled binary reads the `.env` in its own folder.

## Authentication

- **Outbound to DRH**: every call carries `Authorization: Bearer <token>` and `X-ClientId`. The token is the caller's own when one was presented, else the account's: `POST /api/v2/auth/signon {username, password}` returns an `accessToken` (with `refreshToken`, `expiresAfter` and `idleTimeout`), used as the Bearer on the `/api-op/v1/*` data calls and cached for 90% of `expiresAfter` (else for `DRH_TOKEN_TTL_SECONDS`), and signed on again after a 401.
- **Inbound, token mode** (`AUTH_REQUIRED` not `false`): requires the tenant pin — without `DRH_PIN_CLIENT_ID=true` the server refuses to start (exit 78). DRH tokens are opaque and DRH has no tenant-agnostic token-validation endpoint; its one cheap authenticated read (`GET /api-op/v1/databases/default`, which 401s an absent or invalid token) is tenant-scoped, and the pin makes it sound. `/mcp` requires `Authorization: Bearer <token>`; the server checks the token with that read for the pinned tenant (only a 401 rejects it; any other answer admits it; DRH unreachable is a 401 that isn't counted against the caller), caches the answer 30 s (at most 10,000 tokens), and makes one check per token at a time. A NEW check must pass two budgets (`packages/mcp-drh/src/validation-guard.ts`): 10 failed tokens per client address per minute (a check still waiting counts as one, so a burst can't overshoot) and 600 checks per minute for the server; over either, 429 with `Retry-After`. An admitted token is forwarded; DRH authorizes every call.
- **Inbound, env-credential mode** (`AUTH_REQUIRED=false` with the account): no token is required, every call runs as the configured account, and the server is **local only** — it binds the loopback (`127.0.0.1` and `[::1]`), refuses a request whose `Origin` is a page on another site or whose `Host` isn't the loopback (403), and applies a per-peer flood ceiling. Whoever reaches it on this machine acts as that account; no setting widens it.
- **Sessions and limits**: each MCP session is bound to its creator's token and expires when idle; sessions are capped per caller and globally (`packages/mcp-drh/src/session-store.ts`; token mode: 20 per token, 200 in all). Every mode has a per-peer flood ceiling of 1,200 requests per minute; token mode adds 120 requests per minute per token and a 4 MiB request body (413 over it). Every listener runs in production mode with an unshared port (`packages/mcp-drh/src/serve-mode.ts`), whatever `NODE_ENV` says: an escaped error is a bare 500, and a second instance on the same port fails to start. Every upstream DRH call has a 60 s timeout and a 16 MiB response cap (`packages/mcp-drh/src/client/upstream-limits.ts`). One audit line per tool call goes to stderr (`packages/mcp-drh/src/tool-audit.ts`): the principal (a token hash, or `drh-native:<user>` for the account a token-less call runs as), the tool, the tenant, the outcome, the duration and argument NAMES only — never a value, token or password.

## Building Standalone Binaries

```bash
bun install
cd packages/mcp-drh
bun run build:all      # env check, the Linux and Windows executables, the bundle files, the binary smoke
bun run release:zip    # zips each platform dir: dist/_rp-drh_mcp-server_<platform>_<version>.zip
```

`build:all` leaves one platform dir per executable under `packages/mcp-drh/dist/` (the executable, its launcher, `README.txt`, the quick start and `.env.example`; no `.env`, no secret). The smoke boots the Linux binary on a marker port and checks the tool count, the reported version and a refused write tool.

To run a binary: unzip it, copy `.env.example` to `.env` beside the executable, fill in the values above, and start the launcher. Point your MCP client at `http://localhost:3003/mcp`.

## OpenAPI Type Generation

`packages/mcp-drh/src/client/drh-api.generated.ts` is committed. To regenerate it, set `DRH_OPENAPI_SPEC` (a URL or a local path) in the root `.env`, then run `bun run generate:types:drh`; `generate:types:drh:check` reports a stale file.
