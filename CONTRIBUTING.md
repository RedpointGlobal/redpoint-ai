# Contributing to RedpointAI

Thanks for your interest in RedpointAI. Whether you're reporting a bug, suggesting an improvement, or sending a pull request — your contributions help us build a better open-source AI agent platform for the RPI ecosystem.

Before opening a PR, please read through this guide. Pull requests that don't follow the process below may be closed without review.

## Expectations

RedpointAI is an opinionated, batteries-included agent platform — server, web UI, and MCP server in one monorepo. We welcome contributions across the stack, but please keep these principles in mind:

- **Stay focused on the RPI use case.** Features and skills that meaningfully help users interact with their RPI platform via natural language belong here. Generic agent-framework features that don't tie back to RPI workflows generally don't.
- **Prefer existing patterns.** Reuse the skill router, MCP tool conventions, and shared Zod schemas in `packages/shared/` rather than introducing parallel mechanisms. If you're not sure what the established pattern is, reach out at support@redpointglobal.com first.
- **Small, targeted PRs.** One concern per PR. Mixed refactors and feature additions are hard to review and slow to land.

If you're unsure whether a contribution fits, **reach out at support@redpointglobal.com first** to discuss before writing the code.

## Reporting bugs and requesting features

Email **support@redpointglobal.com** with your bug or feature request. Include steps to reproduce (for bugs), the build version shown in the app's Config tab, and what you expected to happen. The team will review and either accept, request more information, or decline with reasoning.

## Writing a good report

When emailing a bug or feature request:

- **Do** use a clear, descriptive title.
- **Do** describe the actual vs. expected behavior, with steps to reproduce for bugs.
- **Do** include version information (Bun, Node, OS, RedpointAI commit) for bug reports.
- **Do** describe the user-facing motivation for feature requests, not just the implementation idea.
- **Do not** include secrets, API keys, RPI tenant identifiers, or any data covered by your organization's data-handling policy. Redact before posting.
- **Do not** report security vulnerabilities through the support channel — see [Security](#security) below.

## Development Setup

See [Getting Started](docs/getting-started.md) for the full walkthrough. Quick form:


```bash
curl -fsSL https://bun.sh/install | bash    # one-time, if Bun missing
git clone https://github.com/RedpointGlobal/redpoint-ai.git
cd redpoint-ai && bun install && bun run dev
```

`cp .env.example .env` and fill in your LLM provider key before the first run (the example leads with Azure OpenAI; Anthropic/OpenAI single-key alternatives are listed at the bottom). The server lazy-bootstraps the SQLite schema and seeds default workspaces on first start.

After install, `bun run check` is the standalone verifier — re-run it after each branch switch. Once `bun run dev` is up, `bun run check --running` probes the live endpoints.

### First-time git setup (if you haven't used git on this machine before)

If your first commit fails with `Author identity unknown`, you need to set your git identity once:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

The repo includes a `.gitattributes` enforcing LF line endings — Windows users do **not** need to change `core.autocrlf` for this repo.

## Code Structure

```
apps/
  server/
    src/
      routes/         — Hono route handlers (health, workspaces, threads, chat, etc.)
      agents/         — Agent orchestrator (AI SDK streamText wrapper)
      mcp/            — MCP client manager
      store/          — Drizzle schema and database setup
      config/         — Provider configuration and model factory
      middleware/     — Auth middleware (OIDC + API key)
      lib/            — Logger, audit logging
  web/
    app/              — Next.js app router pages
    components/       — React components
packages/
  shared/src/         — Zod schemas and shared types
  skills/src/         — Skill loader, registry, and router
  mcp-rpi/src/        — RPI MCP server and tool definitions
  mcp-drh/src/        — DRH MCP server and tool definitions
skills/               — SKILL.md files (skill definitions)
```

## Writing code

We accept PRs that follow the process here and stay narrow in scope. If you spot something that should change, **reach out at support@redpointglobal.com first** so we can confirm it makes sense before you invest time.

Once an issue is accepted:

1. Fork the repository and create a topic branch from `main`.
2. Make your changes, keeping commits focused and messages descriptive.
3. Add or update tests covering your change. PRs without test coverage for new behavior will not be accepted.
4. Update relevant documentation (README, files under `docs/`, in-code comments where the *why* is non-obvious).
5. Run `bun run check` and `bun run test` locally before opening the PR.
6. Open the PR against `main` with a clear description of the change and a reference to the originating issue.

A maintainer will run `bun run check` and `bun run test` on your PR before merging. Please run both locally first; PRs that fail either will be sent back.

## Running Tests

```bash
# All tests (canonical — uses --filter '*' to isolate each package in its own bun process)
bun run test

# By package
bun run test:server
bun run test:skills
bun run test:shared

# Single file
bun test packages/skills/src/__tests__/loader.test.ts
```

**Always use `bun run test`, not raw `bun test`.** Bun's `mock.module()` registers process-globally and the server integration tests mock `@redpoint-ai/skills`; raw `bun test` discovers all test files into a single process, which can leak that mock into other packages and cascade failures. `bun run test` (and per-file `bun test <file>`) sidestep the leak.

## Building the docker bundle (maintainer flow)

The prebuilt docker bundle is a maintainer artifact — it is not part of either public getting-started path. Produce it from a clone:

```bash
bun run build:bundle
```

It builds the four service images, `docker save`s them into `rp-ai-images.tar`, copies your root `.env` verbatim as the bundle's `.env`, stamps the version from `packages/shared/version.json`, and writes `dist/_rp-ai_web_docker-container_<version>.zip`. Requires Docker running and a filled-in **root `.env`** — including `COMPOSE_PROJECT_NAME=redpointai`, without which the build hard-fails (the launchers' container cleanup keys on the compose project label). The bundle runs all four services, so the whole root `.env` is copied as-is — keep dev-only tooling secrets (e.g. a Semgrep token) in your shell, not in `.env`.

See [docs/architecture.md#deployment-topology](docs/architecture.md#deployment-topology) for the multi-container rationale.

## Coding style

- **Validation:** Zod schemas for everything crossing a package boundary or a network surface. Schemas live in `packages/shared/src/schemas/` so they can be reused across server, web, and MCP.
- **Server:** Hono on Bun. Routes go under `apps/server/src/routes/`. Use `c.set("user", …)` / `c.get("user")` for auth context.
- **Frontend:** Next.js 16 App Router. This is *not* the Next.js from older training data — read `node_modules/next/dist/docs/` if you're unsure about an API. `middleware.ts` is now `proxy.ts`.
- **Styling:** Tailwind CSS v4 via the `@tailwindcss/postcss` plugin (no `tailwind.config` file). shadcn/ui primitives live in `apps/web/components/ui/`.
- **AI SDK v6:** Use `inputSchema` with the `jsonSchema()` wrapper, not `parameters` with Zod. The `tool()` helper is a no-op. See `packages/skills/src/router.ts` for the correct pattern.
- **Comments:** Default to none. Write a comment only when the *why* is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug). Don't explain what well-named code already says.
- **Backwards compatibility:** Don't add compatibility shims for code that doesn't exist yet. Don't keep dead code around with `// removed` comments. Delete it.

## Documentation

Update docs alongside code changes:

- `README.md` if you're changing setup, audiences, or the top-level architecture summary.
- Files under `docs/` if you're adding or changing a documented surface (architecture, providers, API, skills, workspaces).
- In-code comments only when the rationale isn't obvious from the code itself.

If you're adding a new skill, MCP tool, or provider, list it in the appropriate docs page so the next contributor can find it.

## Adding New MCP Tools

1. Choose the appropriate domain file in `packages/mcp-rpi/src/tools/` (or create a new one)
2. Register the tool following the existing `registerTool` pattern in the domain files
3. Define the Zod schema for parameters
4. Implement the handler using the `RPIApiClient`
5. If creating a new domain file, register it in `packages/mcp-rpi/src/server.ts`

## Updating RPI API types

The MCP server consumes a generated TypeScript file —
`packages/mcp-rpi/src/client/rpi-api.generated.ts` — that mirrors the
RPI Integration API's OpenAPI spec. **The file is committed**, so a fresh
clone has working types out of the box. You only need to regenerate when
the upstream API has changed and you want fresh types in your PR.

When to do it:
- A new RPI release shifted the OpenAPI spec (added/removed endpoints,
  changed request/response shapes).
- You're adding a tool that hits an endpoint the current generated file
  doesn't yet know about.
- `bun run --filter @redpoint-ai/mcp-rpi generate:types:check` reports the file is stale.

How:

```bash
# In .env, set RPI_OPENAPI_SPEC to the URL or local path of the spec:
RPI_OPENAPI_SPEC=https://<your-rpi-instance>/swagger/v1/swagger.json
# or:
RPI_OPENAPI_SPEC=/path/to/openapi.yaml

bun run generate:types:rpi   # regenerates rpi-api.generated.ts in place
```

Commit the diff alongside the changes that needed it.

To verify the generated file is in sync with the spec without regenerating
(useful pre-PR):

```bash
bun run --filter @redpoint-ai/mcp-rpi generate:types:check
```

Returns non-zero if the file is stale.

## Creating Skills

1. Create a directory under `skills/` (or `skills/experts/` for expert skills)
2. Add a `SKILL.md` with YAML frontmatter (see [Skills docs](docs/skills.md))
3. For action/hybrid skills, omit `mcpToolFilter` to use **dynamic discovery** (the sub-agent gets all tools the connected MCP server exposes at runtime). Add an explicit `mcpToolFilter: [...]` only when the skill needs scoping for security, focus, or multi-server isolation
4. Restart the server to load the new skill
5. Add the skill name to workspace configs that should use it

### Skill body authoring rule: tool names by skill type

The rule depends on the skill's `type`. The router treats expert skills differently from action and hybrid skills, and the staleness blast-radius differs accordingly.

**Expert skills (`type: expert`)**: bodies must **never** name specific MCP tools. Expert prose is inlined into *every* router system prompt as `## Domain Knowledge` — if the tool surface drifts, stale prose pollutes every routing prompt globally. Bodies prime *domain knowledge* — entities, vocabulary, workflows, principles. Tool descriptions live in the MCP server's tool source and are discovered at runtime.

**Action and hybrid skills (`type: action` or `type: hybrid`)**: bodies **may** name MCP tools, but only those listed in the same skill's `mcpToolFilter`. These skills declare exactly which tools they wire into their sub-agent, so naming those tools in the body aligns the LLM's mental model with the wiring rather than misleading it. The cross-reference test (`packages/skills/src/__tests__/skills-tool-references.test.ts`) enforces both directions: every `mcpToolFilter` entry must be a real registered tool, and every tool-name-shaped identifier in the body must appear in the filter.

The "no tool names" rule still applies in all cases to **tools the skill doesn't own** (a skill referencing tools from a different category, or a skill mentioning a tool that isn't in its own `mcpToolFilter`). Tool names belong only where the skill structurally guarantees they're available.

This rule also keeps expert prose **format-agnostic**: a clean expert body can be lifted into a different agent runtime (e.g., the terminal agent, which wires tools via a `tools.ts` module instead of `mcpToolFilter`) without rewriting.

✘ Don't (in any skill body — references a tool not in this skill's filter):
> See the `rpi-audiences` skill's `list_clients` tool for tenant lookup.

✘ Don't (in expert bodies):
> Use `list_offers` to browse available offers and `create_offer` to add a new one.

✓ Do (in expert bodies):
> Use whatever offer-management tools the connected MCP server exposes — the agent discovers what's available at runtime.

✓ Do (in action/hybrid bodies, when the tools are in `mcpToolFilter`):
> Activate the test workflow with `run_audience_test_workflow`, then poll `get_audience_workflow_activity_status` until terminal, then fetch results via `get_audience_workflow_block_results`.

## Adding a New Provider

1. Add the provider type to `ProviderConfigSchema` in `packages/shared/src/schemas/workspace.ts`
2. Implement the model factory case in `apps/server/src/config/providers.ts`
3. Add the corresponding `@ai-sdk/*` package dependency
4. Update the providers list endpoint
5. If the provider should be selectable from the environment, add a branch to `pickDefaultProvider` in `apps/server/src/store/seed.ts` — the factory case alone does not make it env-selectable

## Debugging

RedpointAI runs four processes during `bun run dev`:

| Process       | Port | Logs                                                                 |
| ------------- | ---- | -------------------------------------------------------------------- |
| `apps/server` | 3000 | Pino — structured JSON to stdout. Set `LOG_LEVEL=debug` for verbose. |
| `apps/web`    | 3001 | Next.js — combined dev server logs to stdout.                        |
| `mcp-rpi`     | 3002 | HTTP transport — request/response logs to stdout.                    |
| `mcp-drh`     | 3003 | HTTP transport — request/response logs to stdout.                    |

Health endpoints (also exercised by `bun run check --running`):

- `http://localhost:3000/api/v1/health`
- `http://localhost:3001/`
- `http://localhost:3002/health`
- `http://localhost:3003/health`

If something fails to start, `bun run check` will usually identify the cause (Bun/Node version drift, lockfile drift, blank `.env`) faster than reading logs.

Note: Bun's hot reload does not cross package boundaries. Changes inside `packages/*` won't trigger a restart in `apps/server` — restart the server manually when editing shared packages.

## Security

**Do not report security vulnerabilities through public GitHub issues, discussions, or PRs.**

If you believe you've found a security vulnerability in RedpointAI, follow the disclosure process in [`SECURITY.md`](SECURITY.md). That document covers the private reporting channel (the Security Response Center email) and the response process.

When contributing code, please also:

- **Never commit secrets.** API keys, RPI tenant credentials, OAuth client secrets, and the `.env` file itself must stay out of the repository. Use `.env.example` for placeholders only.
- **Validate at trust boundaries.** Any external input (HTTP request body, MCP tool argument, AI tool-call argument) gets a Zod schema before it's trusted.
- **Avoid hard-coding URLs or tenant identifiers** in code. Configuration belongs in `.env` and the workspace config.

### Licensing of contributions

By submitting a contribution, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the same license as the project (inbound = outbound). You retain copyright in your contribution; the project receives a license to use it under Apache 2.0 §3.

The root `LICENSE` file governs all source files in this repository. No per-file SPDX headers are required.

## Code of Conduct

We expect contributors to act respectfully and professionally. Personal attacks, harassment, and discriminatory language are not tolerated in issues, PRs, code, or any project space.

This project adopts the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) as its code of conduct. Please review it before contributing.

To report unacceptable behavior, contact the maintainers at **support@redpointglobal.com**.
