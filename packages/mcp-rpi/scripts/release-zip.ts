/**
 * release:zip — package each per-platform dist subdir into a standalone zip
 * for release upload.
 *
 *   dist/rp-rpi-mcp-windows-x64/   →  dist/rp-rpi-mcp-windows-x64.zip
 *   dist/rp-rpi-mcp-macos-arm64/   →  dist/rp-rpi-mcp-macos-arm64.zip
 *   dist/rp-rpi-mcp-macos-intel/   →  dist/rp-rpi-mcp-macos-intel.zip
 *   dist/rp-rpi-mcp-linux-x64/     →  dist/rp-rpi-mcp-linux-x64.zip
 *
 * Pure-JS via adm-zip — no `zip` (bash) or `Compress-Archive` (PowerShell)
 * host dependency. Same behavior on every host that runs Bun.
 *
 * Excludes any dev-convenience `.env` from the zip — only `.env.example`
 * ships. Sets +x on the binary and the launcher inside the zip on unix
 * platforms (zip metadata; macOS/Linux honor it on extract).
 *
 * After zipping each platform, the source subdir is deleted so `dist/` ends
 * up holding only the four release zips. Devs who want to run a binary
 * locally can either unzip into a temp folder or run `bun run build:all`
 * alone (without release:zip) to keep the subdirs for iteration.
 *
 * Run: `bun run release:zip` (after `bun run build:all`).
 */

import { existsSync, readdirSync, statSync, readFileSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import AdmZip from "adm-zip";

const here = import.meta.dir;
const pkgRoot = join(here, "..");
const dst = join(pkgRoot, "dist");

if (!existsSync(dst)) {
  console.error(`[release-zip] dist/ not found at ${dst} — run \`bun run build:all\` first.`);
  process.exit(1);
}

// Per-platform subdirs follow the rp-rpi-mcp-<platform>/ naming convention.
const platforms = readdirSync(dst, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("rp-rpi-mcp-"))
  .map((e) => e.name)
  .sort();

if (platforms.length === 0) {
  console.error(`[release-zip] No platform subdirs in ${dst} — run \`bun run build:all\` first.`);
  process.exit(1);
}

// Files always excluded from release zips:
const EXCLUDE = new Set([".env"]);

// Files that should be marked executable inside the zip on unix platforms.
function shouldBeExecutable(platformDir: string, fileName: string): boolean {
  if (platformDir.startsWith("rp-rpi-mcp-windows")) return false;
  if (fileName.startsWith("rp-rpi-mcp-")) return true; // the binary
  if (fileName.endsWith(".sh")) return true;
  if (fileName.endsWith(".command")) return true;
  return false;
}

let zipped = 0;
const summary: Array<{ name: string; bytes: number; entries: number }> = [];

for (const platform of platforms) {
  const subdir = join(dst, platform);
  const zipPath = join(dst, `${platform}.zip`);

  // Stale zip from a prior run gets replaced (don't append to a partial).
  if (existsSync(zipPath)) unlinkSync(zipPath);

  const zip = new AdmZip();
  let entryCount = 0;

  for (const entry of readdirSync(subdir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (EXCLUDE.has(entry.name)) continue;

    const filePath = join(subdir, entry.name);
    const data = readFileSync(filePath);
    zip.addFile(`${platform}/${entry.name}`, data);

    if (shouldBeExecutable(platform, entry.name)) {
      // adm-zip stores a single 32-bit `attr` field combining DOS attrs
      // (lower 16) and unix mode (upper 16). 0o755 << 16 sets +rwxr-xr-x.
      const zipEntry = zip.getEntry(`${platform}/${entry.name}`);
      if (zipEntry) zipEntry.attr = (0o755 << 16) | 0;
    }

    entryCount += 1;
  }

  zip.writeZip(zipPath);
  const { size } = statSync(zipPath);
  summary.push({ name: `${platform}.zip`, bytes: size, entries: entryCount });
  zipped += 1;

  // The per-platform subdir is scratch space — once it's been zipped, the zip
  // is the artifact of record. Delete the subdir so `dist/` ends up holding
  // only the four release zips. Devs who want to run a binary locally can
  // unzip into a temp folder, or run `bun run build:all` (without
  // release:zip) to keep the subdirs for iteration.
  rmSync(subdir, { recursive: true, force: true });
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

console.log(`[release-zip] Wrote ${zipped} zip(s) to ${dst}:`);
for (const s of summary) {
  console.log(`  ${s.name.padEnd(40)} ${s.entries} files  ${fmtMB(s.bytes)}`);
}
