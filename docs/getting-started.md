# Getting Started

Install + configure paths for all three audiences. Each path is independent — pick yours and skip the others.

- [**Code contributor**](#code-contributor-developer-install) — live dev env for editing / testing / building RP_AI code (Linux, macOS, or Windows-via-WSL2).
- [**Non-tech evaluator**](#non-tech-evaluator-demo-with-docker) — full stack running in containers, zero runtime install beyond Docker.
- [**Agent developer**](#agent-developer-standalone-mcp-server) — single-platform binary; point any MCP client (Claude Desktop, Cursor, langchain, …) at it.

After install, see the shared [Configuration](#configuration), [Verify the install](#verify-the-install), and [First steps](#first-steps) sections at the bottom.

---

## Code contributor: Developer install

For folks editing/testing/building RP_AI code itself. End state: server :3000 + web :3001 + mcp :3002 all running locally with hot-reload.

> **Windows users**: this path runs inside a **WSL2 Ubuntu shell, NOT PowerShell**. If you don't have WSL2 yet — in PowerShell as admin: `wsl --install`, reboot, then launch Ubuntu from the Start menu (first launch prompts for a UNIX username and password). Every command in this section runs inside that Ubuntu shell.

### Prerequisites

**Shell**: WSL2 Ubuntu (Windows) / Terminal (macOS) / shell (Linux).

- **Bun** ≥ 1.3.0 — [install](https://bun.sh)
- **Node.js** ≥ 22.6 — required for the Next.js frontend AND for running TypeScript hooks via `--experimental-strip-types`
- **LLM API key** — at least one provider (Azure OpenAI, Anthropic, or OpenAI)
- **RPI instance** — an on-premises RPI environment for MCP tool integration (optional for first run; the seeded workspaces work without it)

Run `bun run check` after install to verify all of these (Bun version, Node version, lockfile integrity, native bindings, env-var presence). It's a manual step — no setup script auto-runs it.

### Install

Two commands from a fresh shell (after a one-time Bun install):

```bash
curl -fsSL https://bun.sh/install | bash    # one-time, if Bun missing
git clone https://github.com/RedPointGlobal/redpoint-ai.git
cd redpoint-ai && bun install && bun run dev
```

`bun install` populates `node_modules`. `bun run dev` brings up server :3000 + web :3001 + mcp :3002 — the server lazy-bootstraps the SQLite schema and seeds default workspaces on first start. Open http://localhost:3001 once it's up.

If you also want to try the container stack later, run `docker compose up` (the same command non-tech evaluators use — see below).

### Run individual services

If you want one service at a time instead of the full `bun run dev`:

```bash
bun run dev:server   # API server on :3000
bun run dev:web      # Next.js UI on :3001
bun run dev:mcp      # MCP server on :3002
```

---

## Non-tech evaluator: Demo with Docker

For folks who want to see RedpointAI running end-to-end without learning the stack. End state: web UI + agent + MCP all in containers, accessible at http://localhost:3001.

### Prerequisites

**Shell**: PowerShell (Windows) / Terminal (macOS) / shell (Linux).

Docker is the only runtime dep — no Bun, no Node, no setup script. See [Installing Docker](#installing-docker) below if you don't have it yet.

### Install

Pick the block for your shell — each is complete and copy-pasteable.

#### Windows (PowerShell)

```powershell
# Free ports 3000-3002 if any other compose stack is already running
$ids = docker ps -q; if ($ids) { docker stop $ids }

git clone https://github.com/RedPointGlobal/redpoint-ai.git
cd redpoint-ai
```

#### macOS / Linux / WSL (bash)

```bash
# Free ports 3000-3002 if any other compose stack is already running
ids=$(docker ps -q); [ -n "$ids" ] && docker stop $ids

git clone https://github.com/RedPointGlobal/redpoint-ai.git
cd redpoint-ai
```

**Drop the `.env` file into the `RP_AI` folder** (use File Explorer / Finder — no shell command needed). Either copy `.env.example` to `.env` and fill it in (see [Configuration](#configuration) for the variable list), or drop in a `.env` a maintainer forwarded you.

Then, in the same shell as above:

```bash
docker compose up
```

First run takes 3–8 minutes while images build. When the log stops scrolling, open http://localhost:3001 in your browser — the app opens directly into the **RedpointAI** chat (no workspace picker). Type a message or click a suggestion chip to start.

**Windows `.env.txt` gotcha**: File Explorer hides file extensions by default, so a file saved as `.env.txt` looks identical to `.env` in the folder view. Enable **View → File name extensions** in Explorer and verify the filename ends in `.env` exactly — no `.txt`. Otherwise `docker compose up` runs with no env vars and the chat will silently fail.

**To stop**: `Ctrl+C` in the terminal where `docker compose up` is running, then `docker compose down` to remove the containers.

Three services (`web`, `server`, `mcp-rpi`) run in their own containers. The optional PostgreSQL service is gated behind `--profile production` — omit it for SQLite-backed runs (the default), or include it with `docker compose --profile production up` for the production-shaped test.

See [docs/deployment.md](deployment.md) for production profiles, env-var reference, and scaling notes; see [docs/architecture.md#deployment-topology](architecture.md#deployment-topology) for the multi-container rationale.

### Installing Docker

Skip this section entirely if you're going with the Developer install path; you don't need Docker for native dev.

- **Windows**: install [Docker Desktop](https://www.docker.com/products/docker-desktop/). The `docker` CLI works in PowerShell out of the box — no further setup needed for the Non-tech evaluator path. If you ALSO want to run `docker` from inside WSL Ubuntu (e.g., for the Code contributor path), enable **Settings → Resources → WSL Integration**.
- **macOS**: install [Docker Desktop](https://docs.docker.com/desktop/install/mac-install/).
- **Linux / WSL native** (no Docker Desktop):

  ```bash
  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
  sudo usermod -aG docker $USER
  sudo service docker start
  ```

  Then start a **fresh shell** so the `docker` group takes effect. **WSL note**: the `sudo` step requires a real TTY — run it from a Windows Terminal Ubuntu tab (or any standalone WSL shell), not from inside an editor's integrated terminal that doesn't pass TTY input.

After installing, verify with `docker --version` and `docker compose version`.

### Docker socket access (WSL2 / Linux only — skip if you're using PowerShell)

If your Docker daemon socket is unreachable (e.g. WSL2 "permission denied"), run from inside a clone of the repo:

```bash
bun run setup-docker
```

This auto-detects your platform (WSL2 / native Linux / macOS) and applies the smallest fix that works in your current shell — typically `setfacl` to grant your user RW access to the docker socket. **No WSL restart, no killed sessions.** Idempotent: safe to re-run any time the daemon restarts and the ACL resets.

(The script is part of the repo, so this assumes you've already cloned it. If you haven't, the `usermod -aG docker` route from the Linux block above is the fully-pre-clone path.)

---

## Agent developer: Standalone MCP Server

For folks who already have an MCP client (Claude Desktop, Cursor, langchain, etc.) and just want a working RPI tool surface to point it at. **No clone, no Bun, no Node.**

**Shell**: not required — interaction is via file manager (extract zip, double-click launcher).

### Install

1. Download the per-platform zip from `packages/mcp-rpi/dist/` (or from the project's GitHub Releases once that's wired):

   | Platform              | Zip                                | Launcher                                 |
   | --------------------- | ---------------------------------- | ---------------------------------------- |
   | Windows x64           | `rp-rpi-mcp-windows-x64.zip`       | `Start MCP Server (Windows).bat`         |
   | macOS arm64 (M-series)| `rp-rpi-mcp-macos-arm64.zip`       | `Start MCP Server (macOS arm64).command` |
   | macOS Intel (x64)     | `rp-rpi-mcp-macos-intel.zip`       | `Start MCP Server (macOS Intel).command` |
   | Linux x64             | `rp-rpi-mcp-linux-x64.zip`         | `Start MCP Server (Linux).sh`            |

2. Extract on the target OS via the OS-native tool (Explorer right-click → Extract All on Windows; double-click on macOS Finder; `unzip` on Linux).

3. Edit the bundled `.env.example` → `.env` and fill in RPI credentials (see [Configuration](#configuration) below for the variable list).

4. Double-click the OS-named launcher.

5. The server listens on `http://localhost:3002/mcp` — point your MCP client at that URL.

> **macOS first run**: right-click the `.command` → Open → "Open" in the Gatekeeper dialog. One-time, because the binary is unsigned.

### What's in each zip

- The platform binary (`rp-rpi-mcp-windows.exe`, `rp-rpi-mcp-linux`, etc. — names self-identify so a stray copy is never ambiguous)
- The OS-named launcher (banner + pre-flight checks + pause-on-exit so error messages stay readable)
- `README.txt` — quick-start for the recipient
- `.env.example` — fill in RPI credentials, rename to `.env`

### Building the binaries (maintainer flow)

If you're producing the zips yourself rather than downloading: see [docs/rpi-mcp-server.md#building-standalone-binaries](rpi-mcp-server.md#building-standalone-binaries) for the full walkthrough. Short version from a fresh clone: `bun install && cd packages/mcp-rpi && bun run build:all && bun run release:zip`.

---

## Configuration

All three paths use the same root `.env` file. The Code contributor path edits it directly in the repo; the Non-tech evaluator path edits it after `git clone`; the Agent developer path edits the `.env.example` shipped inside the zip.

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_RESOURCE_NAME` | one of (LLM) | Azure OpenAI; default workspaces use Azure GPT-4o |
| `ANTHROPIC_API_KEY` | one of (LLM) | Alternative — swap workspace provider settings to use it |
| `OPENAI_API_KEY` | one of (LLM) | Alternative — same |
| `AUTH_SECRET` | yes | JWT secret. Generate with `openssl rand -base64 32` |
| `AUTH_REQUIRED` | optional | `false` for local dev (default), `true` for production |
| `RPI_INTEGRATION_API_URL` | for MCP | Root URL of your RPI Integration API (e.g. `https://rpi.your-company.com`, no `/api/v2` suffix) |
| `RPI_OAUTH_CLIENT_ID` / `RPI_OAUTH_CLIENT_SECRET` | for MCP | OAuth2 client credentials for the RPI `/connect/token` endpoint |
| `RPI_DEFAULT_CLIENT_ID` | for MCP | Default RPI tenant ID sent as the `X-ClientID` header. Tool calls can override per-call via a `clientId` argument. |
| `RPI_PROXY_USER` / `RPI_PROXY_PASS` | optional | Native RPI service account used as a fallback when no per-user token is present |
| `RPI_PROXY_ENABLED` | optional | Set to `false` to force-disable the proxy user even if creds are set |
| `RPI_OPENAPI_SPEC` | build-time | URL or local file path to the RPI OpenAPI spec — used by `bun run generate:types:rpi`, not needed at runtime |
| `MCP_HTTP_PORT` | optional | MCP server HTTP port (default `3002`) |
| `DATABASE_URL` | prod only | PostgreSQL URL. Dev uses SQLite if unset. |

All services (server, web, MCP) read from the single root `.env` — no need to configure env vars in subdirectories.

---

## Verify the install

`bun run check` is the standalone verifier — run it after `bun install` (or after switching branches) to confirm the install is healthy. Code contributor path only; needs Bun.

```bash
bun run check              # default
bun run check --running    # also probe live health endpoints (after dev / compose up)
```

Returns pass/fail per check (Bun version, lockfile integrity, native bindings, env-var presence, AUTH_SECRET safety). Exit 0 means you're ready to configure and run; any `✗` is the install needing attention before proceeding.

---

## Database setup

The schema is automatically pushed to the local SQLite database on first server start. If you want to re-apply manually:

```bash
bunx drizzle-kit push
```

For production PostgreSQL, set `DATABASE_URL` first (see [Configuration](#configuration)).

---

## First steps

On first run, the server auto-seeds a single default workspace: **RedpointAI** (Azure GPT-4.1 with all the RPI domain skills). The app lands directly in its chat — there's no workspace picker.

1. Open http://localhost:3001 in your browser.
2. Pick a workspace tile or click "Create new workspace" — choose a name, pick a provider/model, and optionally connect MCP.
3. Start a conversation in the chat UI.
4. Try a suggestion chip or type your own prompt.
5. Click "Connect RPI" in the header to log in as a specific RPI user — tool calls will run with that user's RBAC instead of the proxy fallback. See [docs/rpi-mcp-server.md#authentication](rpi-mcp-server.md#authentication) for the auth model.

## Using templates

Pre-built workspace templates are available in `skills/templates/`. POST any template JSON directly to the workspaces API:

```bash
curl -X POST http://localhost:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d @skills/templates/marketing-ops.json
```

## Next Steps

- [Architecture](architecture.md) — understand the system design
- [Workspaces](workspaces.md) — configure agent workspaces
- [Skills](skills.md) — learn about the skill system
- [Providers](providers.md) — set up additional LLM providers
- [MCP RPI Server](rpi-mcp-server.md) — RPI tool surface + per-user auth model
- [API Reference](api.md)
- [Deployment](deployment.md) — production topology
