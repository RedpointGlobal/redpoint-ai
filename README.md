# RedpointAI

Open-source AI agent platform for RedPoint Interaction (RPI). Build, compose, and run AI agents against your RPI instance with any LLM provider.

## Tech Stack

Bun | Hono | Next.js | Vercel AI SDK | Drizzle ORM | MCP | AG-UI Protocol | Zod

## Quick Start

Install + run instructions live in **[docs/getting-started.md](docs/getting-started.md)**. Pick your audience below and follow the matching path.

## Audiences

Three audiences, three independent paths — pick the one that matches you:

- **Agent developer** — already have an MCP client (Claude Desktop, Cursor, langchain, in-house agent)
  - You get: a working RPI tool surface to point your client at
  - Path: single-platform binary, no clone, no install → [Standalone MCP Server](docs/getting-started.md#agent-developer-standalone-mcp-server)

- **Non-tech evaluator** — want to see RedpointAI running end-to-end without learning the stack
  - You get: web UI + agent + MCP all running locally
  - Path: zero runtime install beyond Docker → [Demo with Docker](docs/getting-started.md#non-tech-evaluator-demo-with-docker)
  - WSL2 / Linux: if `docker compose up` errors with `permission denied`, see the Docker-socket-access section in [docs/getting-started.md](docs/getting-started.md) — one-line recovery (`bun run setup-docker` if Bun is available, or the no-Bun alternatives documented there)

- **Code contributor** — Linux, macOS, or Windows-via-WSL2
  - You get: a live dev environment for editing / testing / building RP_AI code
  - Path: clone + `bun install && bun run dev` → [Developer install](docs/getting-started.md#code-contributor-developer-install)
  - Windows: install WSL2 first (`wsl --install` in an elevated PowerShell, one-time) if you don't have it yet

## Architecture

RedpointAI uses a two-layer architecture: **MCP servers** expose RPI capabilities as standard tools that any MCP client can consume, while a **Skill Router** groups those tools into domain-specific skills for token-efficient agent orchestration. The frontend communicates with the backend via the AG-UI protocol over SSE, and the backend uses the Vercel AI SDK with BYOM (Bring Your Own Model) provider support. See [docs/architecture.md](docs/architecture.md) for the full breakdown.

## Monorepo Structure

```
apps/server    — Bun + Hono API server (agent engine, REST API)
apps/web       — Next.js frontend (chat UI, workspace management)
packages/shared — Shared schemas, types, and utilities
packages/skills — Skill runtime (loader, registry, router)
packages/mcp-rpi — RPI MCP server (47 tools across 8 domains)
skills/        — Skill definitions (SKILL.md files)
```

## Documentation

- [Getting Started](docs/getting-started.md) — install + configure for all three audiences
- [Architecture](docs/architecture.md)
- [Workspaces](docs/workspaces.md)
- [Skills](docs/skills.md)
- [MCP RPI Server](docs/rpi-mcp-server.md) — including standalone binary build details
- [Providers](docs/providers.md)
- [API Reference](docs/api.md)
- [Deployment](docs/deployment.md)
- [Contributing](CONTRIBUTING.md)
- [FAQ](docs/faq.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE) for the full text. The root `LICENSE` file governs all source files in this repository; no per-file SPDX headers are used.
