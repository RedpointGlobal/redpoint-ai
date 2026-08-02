# RedpointAI

Open-source AI agent platform for Redpoint Interaction (RPI) and Data Readiness Hub (DRH). Build, compose, and run AI agents against your RPI instance with your own LLM provider key (BYOM).

## Tech Stack

Bun | Hono | Next.js | Vercel AI SDK | Drizzle ORM | MCP | AG-UI Protocol | Zod

## Quick Start

Install + build instructions live in **[docs/getting-started.md](docs/getting-started.md)** — an OSS source repository built for seasoned engineers. Both tasks start from one clone (`git clone` + `bun install`), then are independent:

- **Run the stack** — the full dev environment with hot-reload (Linux, macOS, or Windows-via-WSL2) → [Run the stack](docs/getting-started.md#run-the-stack)
- **Build the MCP server binaries** — self-contained Redpoint Interaction (RPI) / Data Readiness Hub (DRH) tool servers for any MCP client (Claude Desktop, Cursor, langchain, …): `bun run build:all && bun run release:zip` from the package directory → [Build the binaries](docs/getting-started.md#build-the-mcp-server-binaries)

## Architecture

RedpointAI uses a two-layer architecture: **MCP servers** expose RPI capabilities as standard tools that any MCP client can consume, while a **Skill Router** groups those tools into domain-specific skills for token-efficient agent orchestration. The frontend communicates with the backend via the AG-UI protocol over SSE, and the backend uses the Vercel AI SDK with BYOM (Bring Your Own Model) provider support. See [docs/architecture.md](docs/architecture.md) for the full breakdown.

## Monorepo Structure

```
apps/server    — Bun + Hono API server (agent engine, REST API)
apps/web       — Next.js frontend (workspace picker, chat UI)
packages/shared — Shared schemas, types, and utilities
packages/skills — Skill runtime (loader, registry, router)
packages/mcp-rpi — RPI MCP server (47 tools across 8 domains)
packages/mcp-drh — DRH MCP server (93 tools across 11 groups)
skills/        — Skill definitions (SKILL.md files)
```

## Documentation

- [Getting Started](docs/getting-started.md) — install, run, and build
- [Architecture](docs/architecture.md)
- [Workspaces](docs/workspaces.md)
- [Skills](docs/skills.md)
- [MCP RPI Server](docs/rpi-mcp-server.md) — including standalone binary build details
- [Providers](docs/providers.md)
- [API Reference](docs/api.md)
- [Contributing](CONTRIBUTING.md)
- [FAQ](docs/faq.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE) for the full text. The root `LICENSE` file governs all source files in this repository; no per-file SPDX headers are used.
