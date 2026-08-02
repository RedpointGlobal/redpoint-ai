# Getting Started

RP_AI is an OSS **source repository built for seasoned engineers**. Everything it produces — the running stack and the standalone MCP server binaries — is built from this source with `bun`. There are no prebuilt downloads; if you are not comfortable cloning and building, this repo is not the delivery vehicle for you (contact support@redpointglobal.com).

```bash
# 1. Clone + install (everything starts here)
git clone https://github.com/RedpointGlobal/redpoint-ai.git
cd redpoint-ai
bun install

# 2. Then pick the task you came for (each is independent):

#   A) Run the full stack — THE primary path; do this first even if you came for the binaries
bun run dev
#      → orchestration server :3000 · web UI :3001 · rpi-mcp server :3002 · drh-mcp server :3003 · open application http://localhost:3001

#   B) Build the standalone MCP server binaries
cd packages/mcp-rpi && bun run build:all && bun run release:zip    # Redpoint Interaction (RPI) tool server
cd packages/mcp-drh && bun run build:all && bun run release:zip    # Data Readiness Hub (DRH) tool server
#      → Windows x64 + Linux x64 zips in packages/mcp-{rpi,drh}/dist/ — binary + launcher + .env.example + README
```

---

## Run the stack

End state: orchestration server :3000 + web UI :3001 + Redpoint Interaction (RPI) MCP server :3002 + Data Readiness Hub (DRH) MCP server :3003 — all running locally with hot-reload.

> **Windows users**: this runs inside a **WSL2 Ubuntu shell, NOT PowerShell**. If you don't have WSL2 yet — in PowerShell as admin: `wsl --install`, reboot, then launch Ubuntu from the Start menu (first launch prompts for a UNIX username and password). Every command in this section runs inside that Ubuntu shell.

### Prerequisites

**Shell**: WSL2 Ubuntu (Windows) / Terminal (macOS) / shell (Linux).

- **Bun** ≥ 1.3.0 — [install](https://bun.sh)
- **Node.js** ≥ 22.6 — required for the Next.js frontend AND for running TypeScript hooks via `--experimental-strip-types`
- **LLM API key** — at least one provider (Azure OpenAI, Anthropic, or OpenAI)
- **RPI instance** — an on-premises RPI environment for MCP tool integration (optional for first run; the seeded workspaces work without it)

Run `bun run check` after install to verify all of these (Bun version, Node version, lockfile integrity, native bindings, env-var presence; add `--running` after `bun run dev` to also probe the live health endpoints). It's a manual step — no setup script auto-runs it.

### Install

```bash
curl -fsSL https://bun.sh/install | bash    # one-time, if Bun missing
git clone https://github.com/RedpointGlobal/redpoint-ai.git
cd redpoint-ai && bun install && bun run dev
```

`bun install` populates `node_modules`. `bun run dev` brings up the orchestration server :3000 + web UI :3001 + rpi-mcp server :3002 + drh-mcp server :3003 — the server lazy-bootstraps the SQLite schema and seeds default workspaces on first start. Open http://localhost:3001 once it's up.

---

## Build the MCP server binaries

Self-contained tool servers you can hand to any MCP client — no Bun or Node on the target machine (Bun is needed to **build**, not to run). Running the full stack first (above) is the quickest way to see the whole platform working before you cut binaries from it.

**Platforms: Linux x64 and Windows x64.** macOS builds are intentionally disabled — unsigned compiled binaries trip Gatekeeper, and we don't ship signed ones. Mac engineers run the servers from source instead (`bun run dev` in the package directory).

1. Build the server for your platform (clone + `bun install` first — see top). From the package directory, `build:all` compiles the binary (Linux + Windows) **and** stages the launcher / `README.txt` / `.env.example`; `release:zip` then packages those into the per-platform zip. (`build:all` is required for a complete zip — `build:linux` alone compiles only the bare binary, so `release:zip` would omit the launcher and `.env.example`.)

   ```bash
   cd packages/mcp-rpi          # or packages/mcp-drh
   bun run build:all            # binary (Linux + Windows) + launcher + README + .env.example
   bun run release:zip          # packages the per-platform zip(s) in ./dist
   ```

   | Platform    | RPI zip (`packages/mcp-rpi/dist/`)          | DRH zip (`packages/mcp-drh/dist/`)          | Launcher                         |
   | ----------- | ------------------------------------------- | ------------------------------------------- | -------------------------------- |
   | Windows x64 | `_rp-rpi_mcp-server_windows-x64_<ver>.zip`  | `_rp-drh_mcp-server_windows-x64_<ver>.zip`  | `Start MCP Server (Windows).bat` |
   | Linux x64   | `_rp-rpi_mcp-server_linux-x64_<ver>.zip`    | `_rp-drh_mcp-server_linux-x64_<ver>.zip`    | `Start MCP Server (Linux).sh`    |


   **The build worked if you see the binary and the zip on disk:**
   - RPI binary — `packages/mcp-rpi/dist/rp-rpi-mcp-linux-x64/rp-rpi-mcp-linux` (or `…-windows-x64/rp-rpi-mcp-windows.exe`)
   - RPI zip — `packages/mcp-rpi/dist/_rp-rpi_mcp-server_<platform>_<ver>.zip`
   - DRH binary — `packages/mcp-drh/dist/rp-drh-mcp-linux-x64/rp-drh-mcp-linux` (or `…-windows-x64/rp-drh-mcp-windows.exe`)
   - DRH zip — `packages/mcp-drh/dist/_rp-drh_mcp-server_<platform>_<ver>.zip`

2. Extract the zip on the target OS (Explorer right-click → Extract All on Windows; `unzip` on Linux). Entries are at the zip root, so you get one folder, not a nested pair.

3. Set up the zip's `.env`. If the build machine had a root `.env`, the zip ships one **prefilled from it** (its product's keys only) — review it. On a fresh clone with no root `.env`, the zip carries only `.env.example` — copy it to `.env` and fill in the credentials (see [Configuration](#configuration) below). The `.env` can also override the listen port (`RPI_MCP_HTTP_PORT`, default `3002`; DRH: `DRH_MCP_HTTP_PORT`, default `3003`).

4. Double-click the OS-named launcher.

5. **Confirm it's running** — open the health URL (or `curl` it):

   ```bash
   curl http://localhost:3002/health      # RPI  (DRH: :3003)
   ```

   - `{"status":"ok","server":"rpi-mcp-server","transport":"http"}` → running and configured.
   - `{"status":"ok",…,"mcp":"degraded","missing":[…]}` → running, but a value in `.env` is missing; the `missing` list names exactly which. Fix it and relaunch.
   - Nothing answers → the server isn't up; re-run the launcher and read its window.

6. Point your MCP client at `http://localhost:3002/mcp` (RPI) / `http://localhost:3003/mcp` (DRH).

> **Read-only by default.** The standalone servers gate their write tools — `tools/list` shows only read tools (RPI 42 of 47, DRH 57 of 93), and a `tools/call` on a gated write is rejected with `Tool <name> disabled`. This is intentional and not switchable via `.env`; the write tools stay registered in source and are re-enabled by a small in-repo allowlist plus a rebuild. See [architecture.md → Read-only enforcement](architecture.md#read-only-enforcement-standalone-servers).

### What's in each zip

- The platform binary (`rp-rpi-mcp-windows.exe`, `rp-rpi-mcp-linux` — names self-identify so a stray copy is never ambiguous)
- The OS-named launcher (banner + pre-flight checks + pause-on-exit so error messages stay readable)
- `.env` — present only when the build machine had a root `.env` (prefilled from it); otherwise copy `.env.example` to `.env`
- `.env.example` — documents each variable, for reference
- `README.txt` + `_rp-ai_quick-start_mcp-server.txt` — quick-start for the recipient

---

## Configuration

Both tasks read the same variables — the stack from the repo root `.env`; the binaries from the `.env` shipped inside each zip.

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_RESOURCE_NAME` | one of (LLM) | Azure OpenAI; default workspaces use Azure gpt-4.1 |
| `ANTHROPIC_API_KEY` | one of (LLM) | Alternative provider — select it in `.env`; there is no in-app provider switcher (config is env + seed) |
| `OPENAI_API_KEY` | one of (LLM) | Alternative provider — same |
| `AUTH_SECRET` | when `AUTH_REQUIRED=true` | JWT secret. Generate with `openssl rand -base64 32` |
| `AUTH_REQUIRED` | optional | `false` for local dev (default), `true` for production |
| `RPI_INTEGRATION_API_URL` | for MCP | Root URL of your RPI Integration API (e.g. `https://rpi.your-company.com`, no `/api/v2` suffix) |
| `RPI_OAUTH_CLIENT_ID` / `RPI_OAUTH_CLIENT_SECRET` | for MCP | OAuth2 client credentials for the RPI `/connect/token` endpoint |
| `RPI_DEFAULT_CLIENT_ID` | for MCP | Default RPI tenant ID sent as the `X-ClientID` header. Tool calls can override per-call via a `clientId` argument. |
| `RPI_PROXY_USER` / `RPI_PROXY_PASS` | optional | Native RPI service account used as a fallback when no per-user token is present |
| `RPI_PROXY_ENABLED` | optional | Set to `false` to force-disable the proxy user even if creds are set |
| `DRH_API_URL` | for DRH | Data Readiness Hub OP-Services API root. **Also the provisioning switch: when unset, the Data Readiness Hub workspace card does not appear** — RPI-only installs see only the RPI card. |
| `DRH_DEFAULT_CLIENT_ID` / `DRH_DEFAULT_DATABASE_ID` | for DRH | Tenant + database the DRH tools are scoped to (server-side; there is no runtime picker) |
| `DRH_PROXY_USER` / `DRH_PROXY_PASS` | for DRH | DRH service account for the Keycloak signon |

---

## First steps

On first run, the server seeds the product workspaces — each preloaded with its foundation + domain-knowledge experts. **Redpoint Interaction** always renders; the **Data Readiness Hub** card appears only when `DRH_API_URL` is set (see [Configuration](#configuration)). The landing page always shows the workspace picker; there is no "create workspace" flow (workspaces come from the seed, and config is env-based).

1. Open http://localhost:3001 in your browser.
2. Click a workspace card to enter its chat.
3. Start a conversation — try a suggestion chip or type your own prompt.
4. Click "Connect RPI" in the header to log in as a specific RPI user — tool calls will run with that user's RBAC instead of the proxy fallback. See [docs/rpi-mcp-server.md#authentication](rpi-mcp-server.md#authentication) for the auth model.

## Next Steps

- [Architecture](architecture.md) — understand the system design
- [Workspaces](workspaces.md) — the workspace model and how the seed provisions it
- [Skills](skills.md) — learn about the skill system
- [Providers](providers.md) — set up additional LLM providers
- [MCP RPI Server](rpi-mcp-server.md) — RPI tool surface + per-user auth model
- [API Reference](api.md)
