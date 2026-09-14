/**
 * Write per-platform launcher / .env.example / README.txt files into each
 * dist/<platform>/ subdir so that after `bun run build:all` every subdir is a
 * complete, ship-ready bundle that can be zipped 1:1 for release:
 *
 *   dist/
 *     rp-drh-mcp-linux-x64/
 *       rp-drh-mcp-linux
 *       Start MCP Server (Linux).sh
 *       README.txt
 *       .env.example
 *     rp-drh-mcp-windows-x64/
 *       rp-drh-mcp-windows.exe
 *       Start MCP Server (Windows).bat
 *       README.txt
 *       .env.example
 *     rp-drh-mcp-macos-arm64/
 *       rp-drh-mcp-macos-arm64
 *       Start MCP Server (macOS arm64).command
 *       README.txt
 *       .env.example
 *     rp-drh-mcp-macos-intel/
 *       rp-drh-mcp-macos-intel
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

import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "fs";
import { parseScopedEnv, renderBinaryTemplate } from "../../../scripts/env-scopes";

/** Normalize to CRLF for Windows batch files. Collapses \r?\n first, so re-running cannot
 *  double-convert an already-CRLF string. */
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

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

title DRH MCP Server
echo ========================================
echo  DRH MCP Server
echo  Port: 3002
echo  Press Ctrl+C to stop.
echo ========================================
echo.

if not exist "rp-drh-mcp-windows.exe" (
    echo ERROR: rp-drh-mcp-windows.exe not found in this folder.
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

.\\rp-drh-mcp-windows.exe

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
 DRH MCP Server
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
  return `DRH MCP Server — ${displayName}
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
  port. Set \`RPI_MCP_HTTP_PORT\` in \`.env\` to pick a different one.

- 401 from RPI on tool calls — double-check your \`RPI_OAUTH_CLIENT_ID\`,
  \`RPI_OAUTH_CLIENT_SECRET\`, and proxy user credentials against your RPI
  instance.

- The window flashes and closes — run from a terminal instead of
  double-clicking the raw binary, so you can read the error. The
  launcher script handles this for you.

- (macOS) "rp-drh-mcp-... cannot be opened because it is from an
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

/**
 * Quick-start shipped alongside the binary. Covers BOTH standalone servers
 * (RPI :3002 and DRH :3003) on purpose — a rep may take either or both, and a
 * single doc beats two that drift apart. Kept identical in the mcp-rpi copy of
 * this script; edit both together.
 *
 * No macOS: build:all produces linux + windows only (the macos targets are
 * disabled in package.json). Documenting a zip we do not produce is how the
 * previous version of this doc sent people looking for files that never existed.
 */
const QUICK_START_NAME = "_rp-ai_quick-start_mcp-server.txt";
const quickStartContent = `RedpointAI — MCP Server Quick Start
===================================

Two standalone MCP servers ship separately. Take one or both — they use
different ports, so they can run at the same time.

  Redpoint Interaction (RPI)   47 tools   localhost:3002
  Data Readiness Hub  (DRH)    93 tools   localhost:3003


(1) Download the zip for your OS:

    Windows x64    _rp-rpi_mcp-server_windows-x64_<version>.zip
                   _rp-drh_mcp-server_windows-x64_<version>.zip
    Linux x64      _rp-rpi_mcp-server_linux-x64_<version>.zip
                   _rp-drh_mcp-server_linux-x64_<version>.zip

    The version in the filename matches the RedpointAI web build, so all
    three artifacts in a shared folder state the same number.


(2) Extract it:

    Windows:  right-click the zip -> Extract All...
    Linux:    unzip _rp-rpi_mcp-server_linux-x64_<version>.zip


(3) Open the extracted folder. You'll see:

    - The binary     rp-rpi-mcp-windows.exe  /  rp-rpi-mcp-linux
                     rp-drh-mcp-windows.exe  /  rp-drh-mcp-linux
    - A launcher     Start MCP Server (Windows).bat  /  (Linux).sh
    - .env.example   keys only — copy to .env and fill in your values
    - README.txt


(4) Copy .env.example to .env and fill in your values:

    RPI    RPI_INTEGRATION_API_URL, RPI_OAUTH_CLIENT_ID,
           RPI_OAUTH_CLIENT_SECRET, RPI_DEFAULT_CLIENT_ID
    DRH    DRH_API_URL, DRH_DEFAULT_CLIENT_ID,
           DRH_PROXY_USER, DRH_PROXY_PASS

    (The bundle ships keys only — no secrets — so this step is required.)


(5) Double-click the launcher:

    Windows:  Start MCP Server (Windows).bat
    Linux:    Start MCP Server (Linux).sh


(6) The server is listening at:

    RPI    http://localhost:3002/mcp
    DRH    http://localhost:3003/mcp

    Point your MCP client at that URL.


(7) When you're done: close the launcher window (or Ctrl+C if it is
    attached to a terminal).


------------------------------------------------------------------------
VERIFY / TROUBLESHOOT
------------------------------------------------------------------------

Is it up?  Open the health URL in a browser:

    http://localhost:3002/health      (RPI)
    http://localhost:3003/health      (DRH)

  {"status":"ok", ...}
      Running and configured.

  {"status":"ok", ..., "mcp":"degraded", "missing":["..."]}
      Running, but a value in .env is missing. The "missing" list names
      exactly which one. Fix it in .env and restart the launcher.

  Nothing answers at all
      The server is not running. Re-run the launcher and read the window
      before it closes.

  Port already in use
      Something else holds 3002/3003. Close it, or change the port in .env
      (RPI_MCP_HTTP_PORT for RPI, DRH_MCP_HTTP_PORT for DRH) and point your
      client at the new port.


------------------------------------------------------------------------
POINTING AT YOUR OWN INSTANCE
------------------------------------------------------------------------

The bundle ships .env.example (keys only, no secrets). Copy it to .env and
fill in the values for your environment, then restart the launcher:

    RPI    RPI_INTEGRATION_API_URL, RPI_OAUTH_CLIENT_ID,
           RPI_OAUTH_CLIENT_SECRET, RPI_DEFAULT_CLIENT_ID
    DRH    DRH_API_URL, DRH_DEFAULT_CLIENT_ID,
           DRH_PROXY_USER, DRH_PROXY_PASS

Once you fill in .env it holds real credentials — treat the folder as
sensitive and do not repost it.
`;

// DERIVED from the committed root .env.example (single source of truth for scope
// + keys) via scripts/env-scopes.ts — no hand-maintained key list, no drift. It
// carries ONLY mcp-drh's scoped keys (AUTH_REQUIRED + DRH_*), secrets EMPTY:
// nothing secret ships in the zip (decision B). The rep copies it to .env.
const envExampleContent = renderBinaryTemplate(
  parseScopedEnv(readFileSync(join(repoRoot, ".env.example"), "utf8")).vars,
  "mcp-drh",
  "DRH MCP Server",
);

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
    subdir: "rp-drh-mcp-windows-x64",
    binary: "rp-drh-mcp-windows.exe",
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
  //   subdir: "rp-drh-mcp-macos-arm64",
  //   binary: "rp-drh-mcp-macos-arm64",
  //   launcher: "Start MCP Server (macOS arm64).command",
  //   launcherContent: unixWrapper("rp-drh-mcp-macos-arm64"),
  //   launcherIsExecutable: true,
  //   display: "macOS arm64 (Apple Silicon)",
  //   gatekeeper: true,
  // },
  // {
  //   subdir: "rp-drh-mcp-macos-intel",
  //   binary: "rp-drh-mcp-macos-intel",
  //   launcher: "Start MCP Server (macOS Intel).command",
  //   launcherContent: unixWrapper("rp-drh-mcp-macos-intel"),
  //   launcherIsExecutable: true,
  //   display: "macOS Intel (x64)",
  //   gatekeeper: true,
  // },
  {
    subdir: "rp-drh-mcp-linux-x64",
    binary: "rp-drh-mcp-linux",
    launcher: "Start MCP Server (Linux).sh",
    launcherContent: unixWrapper("rp-drh-mcp-linux"),
    launcherIsExecutable: true,
    display: "Linux x64",
    gatekeeper: false,
  },
];

// ---------------------------------------------------------------------------
// Write per-platform bundles
// ---------------------------------------------------------------------------

let platformsWritten = 0;

// Decision B: NO secret value ships in the binary zip. The bundle carries only
// the empty, scope-sliced .env.example (keys only) derived above; the rep copies
// it to .env and fills in values. Double-click-with-real-values convenience lives
// in the internal full-stack container, never in a public/retail binary download.

for (const p of platforms) {
  const subdir = join(dst, p.subdir);
  if (!existsSync(subdir)) mkdirSync(subdir, { recursive: true });

  const launcherPath = join(subdir, p.launcher);
  // Windows batch launchers ship CRLF: cmd.exe expects it, and LF-only .bat is the classic
  // source of "The system cannot find the batch label" on goto/label constructs. Gated on the
  // .bat extension, NOT applied at the write call — the Linux .sh goes through this same
  // writeFileSync, and CRLF there yields `bad interpreter: /bin/bash^M`. The .gitattributes
  // *.bat rule cannot reach these files: they are generated here, never tracked.
  writeFileSync(
    launcherPath,
    p.launcher.endsWith(".bat") ? crlf(p.launcherContent) : p.launcherContent,
  );
  if (p.launcherIsExecutable) chmodSync(launcherPath, 0o755);

  writeFileSync(
    join(subdir, "README.txt"),
    readmeFor(p.display, p.launcher, p.binary, p.gatekeeper),
  );

  writeFileSync(join(subdir, ".env.example"), envExampleContent);

  writeFileSync(join(subdir, QUICK_START_NAME), quickStartContent);

  // Decision B: no real .env is written into the bundle — only the empty,
  // scope-sliced .env.example above. Public/retail downloads carry zero secrets.

  platformsWritten += 1;
}

console.log(
  `[copy-dist-templates] Wrote ${platformsWritten} platform bundle(s) to ${dst} (empty scope-sliced .env.example only — no secrets shipped)`,
);
