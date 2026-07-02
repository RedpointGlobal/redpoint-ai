#!/usr/bin/env bun
/**
 * bun run setup-docker — auto-fix Docker daemon access for OSS contributors.
 *
 * Detects platform (WSL2 / native Linux / macOS) and applies the smallest
 * fix that makes `docker info` work in the current shell, without forcing
 * a `wsl --shutdown` (which would kill every other WSL session — including
 * any running claude / dev / editor processes).
 *
 * Primary fix on WSL/Linux: `setfacl -m u:$USER:rw /var/run/docker.sock`.
 * Effect is immediate, doesn't require docker-group membership, doesn't
 * disturb other shells. Resets on docker daemon restart (rare in dev) —
 * just re-run this script to re-apply.
 *
 * Idempotent: if `docker info` already works, exits 0 with "already
 * configured." Safe to run any number of times.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[90m";

function info(s: string) { console.log(s); }
function pass(s: string) { console.log(`  ${GREEN}✓${RESET} ${s}`); }
function warn(s: string) { console.log(`  ${YELLOW}!${RESET} ${s}`); }
function err(s: string)  { console.log(`  ${RED}✗${RESET} ${s}`); }

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function runInherit(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status === 0;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type Platform = "wsl" | "linux" | "macos" | "other";

function detectPlatform(): Platform {
  if (process.platform === "darwin") return "macos";
  if (process.platform !== "linux") return "other";
  // WSL2 puts "microsoft" or "WSL" in /proc/sys/kernel/osrelease
  try {
    const osrelease = readFileSync("/proc/sys/kernel/osrelease", "utf8").toLowerCase();
    if (osrelease.includes("microsoft") || osrelease.includes("wsl")) return "wsl";
  } catch {
    // proc not readable — assume native Linux
  }
  return "linux";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

info("bun run setup-docker — fix Docker daemon access\n");

const platform = detectPlatform();
info(`  Platform: ${platform}`);

// 1. Docker CLI present?
const dockerCli = run("docker", ["--version"]);
if (!dockerCli.ok) {
  err("Docker CLI not found on PATH.");
  info("");
  if (platform === "wsl") {
    info("  Install Docker Desktop for Windows (it auto-integrates with WSL2):");
    info("    https://www.docker.com/products/docker-desktop/");
  } else if (platform === "macos") {
    info("  Install Docker Desktop for Mac:");
    info("    https://www.docker.com/products/docker-desktop/");
  } else {
    info("  Install Docker Engine (apt/dnf/pacman per your distro):");
    info("    https://docs.docker.com/engine/install/");
  }
  process.exit(1);
}
pass(`Docker CLI installed (${dockerCli.stdout})`);

// 2. Daemon already reachable? Exit 0 if yes.
const daemonProbe = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
if (daemonProbe.ok && daemonProbe.stdout) {
  pass(`Docker daemon reachable (server ${daemonProbe.stdout})`);
  info("");
  info(`${GREEN}Already configured. Nothing to do.${RESET}`);
  process.exit(0);
}

// 3. Daemon not reachable. Diagnose and fix per platform.
err(`Docker daemon not reachable: ${daemonProbe.stderr.split("\n")[0] || "unknown error"}`);
info("");

if (platform === "macos") {
  info("On macOS, the docker daemon runs inside Docker Desktop.");
  info("");
  info("  1. Make sure Docker Desktop is running.");
  info("  2. If using docker via WSL/devcontainer, enable Settings → Resources →");
  info("     Advanced → 'Allow the default Docker socket to be used'");
  info("");
  process.exit(1);
}

if (platform === "other") {
  err(`Unsupported platform: ${process.platform}. This script handles WSL/Linux/macOS only.`);
  process.exit(1);
}

// WSL or native Linux from here.

// Is the daemon up at all? Differentiate "permission denied" from "cannot connect".
const stderr = daemonProbe.stderr.toLowerCase();
if (stderr.includes("cannot connect") || stderr.includes("connection refused")) {
  info("The docker daemon is not running.");
  info("");
  if (platform === "wsl") {
    info("  Start Docker Desktop on Windows and ensure WSL2 integration is enabled");
    info("  (Settings → Resources → WSL Integration → enable for your distro).");
  } else {
    info("  Start the daemon:  sudo systemctl start docker");
    info("                or:  sudo service docker start");
  }
  process.exit(1);
}

if (!stderr.includes("permission denied")) {
  err(`Unrecognized error from docker info: ${daemonProbe.stderr.split("\n")[0]}`);
  process.exit(1);
}

// Permission denied. Apply the smallest fix that works in the CURRENT shell.
info(`The daemon is up but the current shell can't read its socket (${DIM}/var/run/docker.sock${RESET}).`);
info("");
info("Recommended fix: grant your user RW access to the socket via setfacl.");
info("  - Takes effect immediately, no shell or WSL restart needed");
info("  - Doesn't require docker-group membership");
info("  - Resets if the docker daemon restarts (rare in dev) — just re-run this script");
info("");

const sockPath = "/var/run/docker.sock";
if (!existsSync(sockPath)) {
  err(`Socket missing: ${sockPath}`);
  info("  The daemon may not be running, or this distro uses a non-default socket path.");
  process.exit(1);
}

// Check setfacl availability. If the acl package isn't installed, offer to install.
const setfaclProbe = run("setfacl", ["--version"]);
if (!setfaclProbe.ok) {
  warn("setfacl not installed. Install the acl package?");
  info(`     ${DIM}(this runs: sudo apt-get install -y acl)${RESET}`);
  const ans = await prompt("  [Y/n] ");
  if (ans !== "" && ans !== "y" && ans !== "yes") {
    info("");
    info("Skipped. Manual alternatives:");
    info("  - sudo apt install acl    # then re-run: bun run setup-docker");
    info("  - sg docker -c \"<command>\"  # per-command escape hatch (no install)");
    process.exit(1);
  }
  info("");
  if (!runInherit("sudo", ["apt-get", "install", "-y", "acl"])) {
    err("apt-get install acl failed.");
    info("");
    info("Long-term alternatives that don't need acl:");
    info("  - sudo usermod -aG docker $USER  (then re-login or wsl --shutdown to apply)");
    info('  - sg docker -c "<command>"  (per-command, no install)');
    process.exit(1);
  }
  info("");
}

// Apply the ACL.
const user = process.env.USER || process.env.USERNAME;
if (!user) {
  err("Could not determine current user (USER env var unset).");
  process.exit(1);
}
info(`Granting ${user} RW access to ${sockPath} ...`);
info(`     ${DIM}(this runs: sudo setfacl -m u:${user}:rw ${sockPath})${RESET}`);
if (!runInherit("sudo", ["setfacl", "-m", `u:${user}:rw`, sockPath])) {
  err("setfacl failed.");
  process.exit(1);
}

// Re-probe.
info("");
const reprobe = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
if (reprobe.ok && reprobe.stdout) {
  pass(`Docker daemon reachable (server ${reprobe.stdout})`);
  info("");
  info(`${GREEN}Done. docker works in this shell now — no restart needed.${RESET}`);
  info("");
  info(`${DIM}Note: ACL resets if the docker daemon restarts. Just re-run`);
  info(`bun run setup-docker if that happens.${RESET}`);
  process.exit(0);
} else {
  err("setfacl applied but docker info still fails:");
  info(`    ${reprobe.stderr.split("\n")[0]}`);
  info("");
  info("Long-term alternative (heavier — kills all WSL sessions on WSL):");
  info("  1. sudo usermod -aG docker $USER");
  info("  2. (WSL only) From Windows PowerShell: wsl --shutdown");
  info("  3. Reopen your terminal");
  process.exit(1);
}
