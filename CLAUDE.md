# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

First-time setup: `cp .env.example .env`, then add at least one provider key (e.g. `ANTHROPIC_API_KEY`) — the seeded default workspace needs a model provider. See [docs/getting-started.md](docs/getting-started.md) for the full setup and [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

```bash
bun install                    # install all workspace deps (postinstall sets git core.fileMode false silently)
bun run dev                    # start all services (server:3000, web:3001, mcp:3002); server lazy-bootstraps SQLite schema on first start
bun run dev:server             # server only (Bun + Hono, hot reload)
bun run dev:web                # Next.js frontend only (port 3001)
bun run dev:mcp                # MCP server only (port 3002)
bunx drizzle-kit push          # manually push schema changes (lazy-bootstrap auto-runs it on first server start)
bun run test                   # run all tests (canonical — uses --filter '*' to isolate per-package)
                               # NOTE: does NOT reach tests/integration/ — routing/accuracy is a
                               # separate suite (bun run test:accuracy-evaluation). A green run here
                               # says nothing about routing; the eval sat broken for a whole release
                               # stretch without this suite noticing.
bun run test:server            # server tests (runs with AUTH_REQUIRED=false)
bun run test:skills            # skills package tests
bun run test:shared            # shared package tests
bun test <file>                # single test file (scoped, safe)
bun run generate:types:rpi     # generate TypeScript types from RPI OpenAPI spec
```

### OpenAPI Type Generation

The MCP server uses `openapi-typescript` to generate TypeScript interfaces from the RPI Integration API's OpenAPI spec. The generated file `packages/mcp-rpi/src/client/rpi-api.generated.ts` **is committed**, so a fresh clone builds with working types out of the box — you only need to regenerate when the RPI OpenAPI spec changes (then commit the diff).

Set `RPI_OPENAPI_SPEC` in the root `.env` to a URL or local file path:
```bash
RPI_OPENAPI_SPEC=https://<your-rpi-instance>/swagger/v1/swagger.json
# or
RPI_OPENAPI_SPEC=/path/to/openapi.yaml
```

Then run `bun run generate:types:rpi`. If `RPI_OPENAPI_SPEC` is unset and no generated file exists, the script errors. If the generated file already exists, it skips with a warning.

Tool files use schema types from `components["schemas"]` (not path-level types) because tool paths (`/audiences`) don't match OpenAPI spec paths (`/api/v2/client/files/audience`). See `packages/mcp-rpi/src/tools/audiences.ts` for the pattern.

## Architecture

**Request flow**: Web UI (`useChat` + `DefaultChatTransport`) → `POST /api/v1/workspaces/:id/chat` → workspace config loaded from SQLite/PostgreSQL → skills filtered by `config.skills` via `registry.filterByNames()` → `createModelFromConfig()` in `apps/server/src/config/providers.ts` builds an AI SDK v6 `LanguageModel` → `buildRouterSystemPrompt()` inlines expert skill knowledge into the system prompt → if action/hybrid skills exist, `createSkillRouterTool()` adds an `execute_skill` meta-tool → `createAgentUIStreamResponse()` with `ToolLoopAgent` streams AG-UI SSE events back to the frontend.

**Skill router two-tier pattern**: Expert skills (knowledge-only) are inlined directly into the system prompt as "Domain Knowledge" sections via `buildRouterSystemPrompt()` in `packages/skills/src/router.ts`. Hybrid and action skills appear in a compact catalog (~500 tokens) and are dispatched via the `execute_skill` meta-tool to isolated sub-agents with filtered MCP tools. When `execute_skill(skillName, input, operation?)` is called, a sub-agent spawns via `generateText()` (not streaming) with only that skill's MCP tools and the SKILL.md body as its system prompt. If a workspace has only expert skills, no `execute_skill` tool is added.

**Pattern A — operation-class dynamic tool filter**: heavy skills can declare an `operations:` nested-map in their SKILL.md frontmatter, mapping operation names (e.g., `list`, `get`, `count`, `metadata`, `workflow`) to narrower tool subsets. When the router LLM passes `operation` to `execute_skill`, the sub-agent gets that subset instead of the full `mcpToolFilter`, shrinking the sub-agent prompt (~10K → ~2-4K on common list/get prompts). Missing/unknown operation falls back to `mcpToolFilter` — safe by design. The catalog emits an `Operations: list | get | …` line per skill that declares operations; Routing Guideline #11 tells the router LLM to pass the matching operation. Currently configured on `rpi-audiences`, `rpi-interactions`, `rpi-selection-rules`, `rpi-attributes` (the first adopted domain skill; the read-surface expansion's generated tools reach the orchestrator via new domain skills adopted one at a time, each eval-gated).

**MCP tool namespacing**: Tools from MCP servers are namespaced as `serverName__toolName` (e.g., `rpi__list_audiences`). Skills reference base tool names in their `mcpToolFilter` frontmatter; the MCP client in `apps/server/src/mcp/client.ts` matches and filters at runtime.

**Two chat endpoints — don't mix them up**:
- `/api/v1/workspaces/:id/chat` — useChat-compatible, accepts UI message format with `id`, `role`, `parts`
- `/api/v1/.../threads/:threadId/runs/:runId/stream` — raw AG-UI SSE events for server-side integrations

**Database auto-switching**: `apps/server/src/store/db.ts` uses SQLite (`drizzle-orm/bun-sqlite`) when no `DATABASE_URL` is set, PostgreSQL (`drizzle-orm/postgres-js`) when it is. No code change needed to switch.

**Workspace config is an opaque JSON string** in the `workspaces` table `config` column. Validation happens at the route layer via Zod schemas in `packages/shared/src/schemas/workspace.ts`.

## Key Gotchas

- **Root `.env` loading**: Both `apps/server/src/index.ts` and `apps/web/next.config.ts` explicitly load the root `.env` file since Bun/Next.js only auto-load `.env` from their own cwd (`apps/server/` and `apps/web/`). All config goes in the single root `.env` — never create separate `.env` files in subdirectories.
- **Auto-seeding**: On first run, the server auto-creates the SQLite schema (via `drizzle-kit push`) and seeds default workspaces. See `apps/server/src/store/seed.ts`.
- **AI SDK v6 tool schema**: Use `inputSchema` with the `jsonSchema()` wrapper from `ai`, NOT `parameters` with Zod. The `tool()` helper is a no-op that returns its argument unchanged. See `packages/skills/src/router.ts` for the correct pattern.
- **Next.js 16 breaking changes**: This is NOT the Next.js from your training data. Read `node_modules/next/dist/docs/` before changing web app code. `middleware.ts` is now `proxy.ts` with an export named `proxy`.
- **`useSearchParams()` requires `<Suspense>`**: Any component using `useSearchParams()` must be wrapped in a `<Suspense>` boundary or Next.js prerendering will fail.
- **Bun hot reload doesn't cross package boundaries**: Changes in `packages/*` won't trigger reload in `apps/server`. Restart the server manually.
- **Skills directory path**: Resolved relative to the server entry point as `../../../../skills`. The `skills/` directory must remain at repo root.
- **Auth middleware (server)**: Uses Hono `createMiddleware` with `c.set("user", ...)`. Protected routes read `c.get("user")`. Auth is off by default (`AUTH_REQUIRED=false`).
- **Auth middleware (MCP)**: The MCP server has its own auth middleware in `packages/mcp-rpi/src/middleware/auth.ts`. At startup, it auto-detects OIDC via `getLoginSettings()` — if an OpenID provider is configured, JWKS-based JWT verification is used (fast, local crypto via `jose`). For native RPI tokens or when OIDC is unavailable, it falls back to RPI's `validate-token-status` endpoint. Per-user tokens are forwarded to RPI API calls via `extra.authInfo?.token` in tool handlers. When the proxy user is enabled (`RPI_PROXY_USER`/`RPI_PROXY_PASS`), it is used as a fallback when no user token is present; otherwise the call fails.
- **MCP server env vars**: `RPI_INTEGRATION_API_URL` is the root URL of the RPI Integration API (no `/api/v2` suffix). `RPI_OAUTH_CLIENT_ID`/`RPI_OAUTH_CLIENT_SECRET` are the OAuth2 client credentials for `/connect/token`. `RPI_DEFAULT_CLIENT_ID` is the default value used in the `X-ClientID` header (RPI tenant/workspace) — both the MCP server and the RedpointAI agent read it; tools accept an optional per-call `clientId` override. `RPI_PROXY_USER`/`RPI_PROXY_PASS` are optional native RPI service account credentials used as a fallback; presence of both implicitly enables the proxy user, and `RPI_PROXY_ENABLED=false` force-disables it.
- **Docker builds**: Bun workspace symlinks don't survive `COPY`. Dockerfiles install and build in a single stage. The server image needs `python3 make g++` for `better-sqlite3` native compilation.
- **Google provider env var**: `@ai-sdk/google` expects `GOOGLE_GENERATIVE_AI_API_KEY`. The provider status check in `providers.ts` accepts either that or `GOOGLE_API_KEY`.
- **Azure `.chat()` method**: `createAzure()` returns a provider where `provider()` uses the Responses API (`/responses`) and `provider.chat()` uses Chat Completions (`/chat/completions`). Always use `.chat()` — the Responses endpoint returns 404 on most Azure deployments. Default API version is `2024-10-01-preview`.
- **Dark mode**: Uses `next-themes` with `attribute="class"`. `ThemeProvider` wraps the app in `apps/web/app/layout.tsx`. Toggle component in `apps/web/components/theme-toggle.tsx`.
- **Workspace skill filtering**: `config.skills` array filters which skills load per workspace via `registry.filterByNames()` in `packages/skills/src/registry.ts`. If omitted or empty, all skills load. Expert skills are inlined into the prompt; only action/hybrid skills get `execute_skill`.
- **Test invocation — always use `bun run test`, not raw `bun test`**: Bun's `mock.module()` registers process-globally and `apps/server/src/__tests__/integration.test.ts` mocks `@redpoint-ai/skills` — when raw `bun test` discovers all test files into one process, that mock can leak into the `packages/skills/__tests__/*` files and cascade failures (file-discovery order dependent — `/mnt/c` happens to dodge it; ext4 doesn't). The npm script `bun run test` uses `--filter '*' test` so each package runs in a separate bun process — leakage is structurally impossible. Per-file `bun test <file>` is also safe (scoped). Only raw multi-package `bun test` is the footgun.

## Code Conventions

- **Validation**: Zod for all schemas, shared across packages via `packages/shared/src/schemas/`
- **Server framework**: Hono (server), Next.js 16 App Router (web)
- **Styling**: Tailwind CSS v4 via `@tailwindcss/postcss` plugin (no `tailwind.config` file)
- **UI components**: shadcn/ui in `apps/web/components/ui/`
- **API keys**: Prefixed `rpai_`, SHA-256 hashed before storage in `api_keys` table
- **Metrics**: Prometheus counters/gauges/histograms defined in `apps/server/src/routes/metrics.ts`
- **Skill definitions**: `SKILL.md` files with YAML frontmatter (`name`, `type`, `mcpToolFilter`, `maxSteps`) in the `skills/` directory
