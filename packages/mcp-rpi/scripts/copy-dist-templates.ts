/**
 * Write per-platform launcher / .env.example / README.txt files into each
 * dist/<platform>/ subdir so that after `bun run build:all` every subdir is a
 * complete, ship-ready bundle that can be zipped 1:1 for release:
 *
 *   dist/
 *     rp-rpi-mcp-linux-x64/
 *       rp-rpi-mcp-linux
 *       Start MCP Server (Linux).sh
 *       README.txt
 *       .env.example
 *     rp-rpi-mcp-windows-x64/
 *       rp-rpi-mcp-windows.exe
 *       Start MCP Server (Windows).bat
 *       README.txt
 *       .env.example
 *     rp-rpi-mcp-macos-arm64/
 *       rp-rpi-mcp-macos-arm64
 *       Start MCP Server (macOS arm64).command
 *       README.txt
 *       .env.example
 *     rp-rpi-mcp-macos-intel/
 *       rp-rpi-mcp-macos-intel
 *       Start MCP Server (macOS Intel).command
 *       README.txt
 *       .env.example
 *
 * The contents below are the source of truth — there is no separate
 * `dist-templates/` folder. To edit any of the per-platform files, edit the
 * corresponding string literal here and re-run `bun run build:copy-templates`
 * (or `bun run build:all`).
 *
 * Cross-platform on purpose — uses Bun's native fs API so the build works
 * identically on Linux, macOS, Windows, and WSL.
 */

import { mkdirSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "fs";
import { join } from "path";

const here = import.meta.dir;
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");
const dst = join(pkgRoot, "dist");

if (!existsSync(dst)) mkdirSync(dst, { recursive: true });

// ---------------------------------------------------------------------------
// Wrapper templates (one per platform)
// ---------------------------------------------------------------------------

const windowsBat = `@echo off
rem Always run from this .bat's own folder so it can find the .exe
rem regardless of how the user launched it (double-click, cmd, shortcut).
cd /d "%~dp0"

title RPI MCP Server
echo ========================================
echo  RPI MCP Server
echo  Port: 3002
echo  Press Ctrl+C to stop.
echo ========================================
echo.

if not exist "rp-rpi-mcp-windows.exe" (
    echo ERROR: rp-rpi-mcp-windows.exe not found in this folder.
    echo Make sure the .bat and the .exe are in the same folder.
    echo.
    goto END
)

if not exist ".env" (
    echo WARNING: no .env found in this folder.
    echo Copy .env.example to .env and fill in your RPI_* values,
    echo then run this .bat again.
    echo.
    goto END
)

.\\rp-rpi-mcp-windows.exe

:END
echo.
echo ========================================
echo  Server stopped (or failed to start).
echo  Press any key to close this window.
echo ========================================
pause >nul
`;

function unixWrapper(binaryName: string): string {
  return `#!/usr/bin/env bash
# Always run from this script's own folder so it can find the binary
# regardless of how the user launched it (double-click, terminal).
cd "$(dirname "$0")" || exit 1

cat <<'BANNER'
========================================
 RPI MCP Server
 Port: 3002
 Press Ctrl+C to stop.
========================================
BANNER
echo

if [ ! -x "./${binaryName}" ]; then
    echo "ERROR: ${binaryName} not found or not executable in this folder."
    echo "Make sure the launcher and the binary are in the same folder,"
    echo "and the binary has execute permission (chmod +x ${binaryName})."
    echo
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
fi

if [ ! -f ".env" ]; then
    echo "WARNING: no .env found in this folder."
    echo "Copy .env.example to .env and fill in your RPI_* values,"
    echo "then run this launcher again."
    echo
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
fi

./${binaryName}
EXIT_CODE=$?

echo
echo "========================================"
echo " Server stopped (exit code $EXIT_CODE)."
echo " Press any key to close this window."
echo "========================================"
read -n 1 -s -r
exit $EXIT_CODE
`;
}

// ---------------------------------------------------------------------------
// README.txt — end-user quick-start (per-platform variant)
// ---------------------------------------------------------------------------

function readmeFor(displayName: string, launcher: string, binaryName: string, gatekeeper: boolean): string {
  return `RPI MCP Server — ${displayName}
${"=".repeat(displayName.length + 22)}

This folder contains a compiled MCP server that wraps the RPI Integration
API as standard Model Context Protocol tools. Any MCP client (Claude
Desktop, Cursor, a custom agent, etc.) can connect to it over HTTP.

No Node.js, Bun, or monorepo required — the binary is self-contained.


Quick start
-----------

1. Copy \`.env.example\` to \`.env\` in this same folder.

2. Open the new \`.env\` in a text editor and fill in the required
   \`RPI_*\` values:

     - RPI_INTEGRATION_API_URL
     - RPI_OAUTH_CLIENT_ID
     - RPI_OAUTH_CLIENT_SECRET
     - RPI_DEFAULT_CLIENT_ID
     - (optional) RPI_PROXY_USER / RPI_PROXY_PASS

3. Launch the server:

     ${launcher}

${
  gatekeeper
    ? `   First-run on macOS: Right-click the launcher → Open → "Open" in
   the Gatekeeper dialog. Subsequent launches are normal double-click.

`
    : ""
}4. Verify the server is running by opening
   http://localhost:3002/health in a browser, or via curl:

     curl http://localhost:3002/health

   A healthy server returns:
     {"status":"ok","server":"rpi-mcp-server","transport":"http"}


Connecting an MCP client
------------------------

Point your MCP client at \`http://localhost:3002/mcp\`. No auth header
required when \`AUTH_REQUIRED=false\` (the default in \`.env.example\`).


Stopping the server
-------------------

Press Ctrl+C in the server's console window.


Troubleshooting
---------------

- "RPI_INTEGRATION_API_URL is required" — your \`.env\` is missing or the
  file isn't in the same folder as the binary.

- "Address already in use" on port 3002 — another process is using that
  port. Set \`MCP_HTTP_PORT\` in \`.env\` to pick a different one.

- 401 from RPI on tool calls — double-check your \`RPI_OAUTH_CLIENT_ID\`,
  \`RPI_OAUTH_CLIENT_SECRET\`, and proxy user credentials against your RPI
  instance.

- The window flashes and closes — run from a terminal instead of
  double-clicking the raw binary, so you can read the error. The
  launcher script handles this for you.

- (macOS) "rp-rpi-mcp-... cannot be opened because it is from an
  unidentified developer" — right-click the launcher → Open → Open.
  This is one-time; macOS remembers your choice.

- Binary identification: this folder ships \`${binaryName}\`. If you have
  a different platform's binary, download the matching zip from the
  releases page.
`;
}

// ---------------------------------------------------------------------------
// .env.example — same content for every platform.
// ---------------------------------------------------------------------------

const envExampleContent = `# RPI MCP Server — standalone distribution
#
# Copy this file to \`.env\` and fill in your values.
# Place the resulting \`.env\` in the same folder as the binary,
# then launch the server.

# RPI instance root URL (no /api/v2 suffix — the server appends it)
RPI_INTEGRATION_API_URL=https://rpi.your-company.com

# OAuth2 client credentials for the RPI /connect/token password grant.
RPI_OAUTH_CLIENT_ID=
RPI_OAUTH_CLIENT_SECRET=

# Default value for the X-ClientID header (the RPI tenant/workspace ID).
# Used as a fallback when a tool call doesn't carry an explicit clientId.
RPI_DEFAULT_CLIENT_ID=

# HTTP port the MCP server listens on (default 3002).
MCP_HTTP_PORT=3002

# Inbound token validation. Keep \`false\` for local dev; set \`true\` in
# production to require callers to pass an RPI-valid Bearer token.
AUTH_REQUIRED=false

# Optional proxy user — a native RPI service account used as a fallback
# when no per-user token is present on an incoming request.
# Setting RPI_PROXY_USER and RPI_PROXY_PASS implicitly enables the proxy.
# Set RPI_PROXY_ENABLED=false to force-disable it.
# RPI_PROXY_USER=your-service-account-username
# RPI_PROXY_PASS=your-service-account-password
# RPI_PROXY_ENABLED=false
`;

// ---------------------------------------------------------------------------
// Per-platform manifest
// ---------------------------------------------------------------------------

type PlatformDef = {
  subdir: string;
  binary: string;
  launcher: string;
  launcherContent: string;
  launcherIsExecutable: boolean;
  display: string;
  gatekeeper: boolean;
};

const platforms: PlatformDef[] = [
  {
    subdir: "rp-rpi-mcp-windows-x64",
    binary: "rp-rpi-mcp-windows.exe",
    launcher: "Start MCP Server (Windows).bat",
    launcherContent: windowsBat,
    launcherIsExecutable: false,
    display: "Windows x64",
    gatekeeper: false,
  },
  // macOS targets are temporarily disabled: a macOS dev hit runtime issues
  // with the unsigned bun-darwin binaries (Gatekeeper / quarantine attribute
  // friction even after right-click → Open). Restoration when Apple Developer
  // signing is set up: uncomment the two entries below AND add `&& bun run
  // build:macos && bun run build:macos-intel` back into the build:all script
  // in package.json. The build:macos / build:macos-intel script keys remain
  // in package.json as orphans for the same restoration path.
  // {
  //   subdir: "rp-rpi-mcp-macos-arm64",
  //   binary: "rp-rpi-mcp-macos-arm64",
  //   launcher: "Start MCP Server (macOS arm64).command",
  //   launcherContent: unixWrapper("rp-rpi-mcp-macos-arm64"),
  //   launcherIsExecutable: true,
  //   display: "macOS arm64 (Apple Silicon)",
  //   gatekeeper: true,
  // },
  // {
  //   subdir: "rp-rpi-mcp-macos-intel",
  //   binary: "rp-rpi-mcp-macos-intel",
  //   launcher: "Start MCP Server (macOS Intel).command",
  //   launcherContent: unixWrapper("rp-rpi-mcp-macos-intel"),
  //   launcherIsExecutable: true,
  //   display: "macOS Intel (x64)",
  //   gatekeeper: true,
  // },
  {
    subdir: "rp-rpi-mcp-linux-x64",
    binary: "rp-rpi-mcp-linux",
    launcher: "Start MCP Server (Linux).sh",
    launcherContent: unixWrapper("rp-rpi-mcp-linux"),
    launcherIsExecutable: true,
    display: "Linux x64",
    gatekeeper: false,
  },
];

// ---------------------------------------------------------------------------
// Write per-platform bundles
// ---------------------------------------------------------------------------

let platformsWritten = 0;
let envCopied = 0;

const rootEnv = join(repoRoot, ".env");
const hasRootEnv = existsSync(rootEnv);

for (const p of platforms) {
  const subdir = join(dst, p.subdir);
  if (!existsSync(subdir)) mkdirSync(subdir, { recursive: true });

  const launcherPath = join(subdir, p.launcher);
  writeFileSync(launcherPath, p.launcherContent);
  if (p.launcherIsExecutable) chmodSync(launcherPath, 0o755);

  writeFileSync(
    join(subdir, "README.txt"),
    readmeFor(p.display, p.launcher, p.binary, p.gatekeeper),
  );

  writeFileSync(join(subdir, ".env.example"), envExampleContent);

  // Dev convenience: copy root .env into each subdir so binaries can launch
  // immediately after `bun run build:all` without manual post-build steps.
  // .env is gitignored — no leak risk via git. release:zip will exclude it
  // from the published zips.
  if (hasRootEnv) {
    copyFileSync(rootEnv, join(subdir, ".env"));
    envCopied += 1;
  }

  platformsWritten += 1;
}

if (hasRootEnv) {
  console.log(
    `[copy-dist-templates] Wrote ${platformsWritten} platform bundle(s) + copied root .env into ${envCopied} subdir(s) (dev convenience; release:zip excludes .env)`,
  );
} else {
  console.log(
    `[copy-dist-templates] Wrote ${platformsWritten} platform bundle(s) to ${dst} (no root .env to copy — customer flow)`,
  );
}
