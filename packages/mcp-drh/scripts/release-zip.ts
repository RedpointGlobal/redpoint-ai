/**
 * release:zip — package each per-platform dist subdir into a standalone zip
 * for release upload.
 *
 *   dist/rp-drh-mcp-windows-x64/   →  dist/rp-drh-mcp-windows-x64.zip
 *   dist/rp-drh-mcp-macos-arm64/   →  dist/rp-drh-mcp-macos-arm64.zip
 *   dist/rp-drh-mcp-macos-intel/   →  dist/rp-drh-mcp-macos-intel.zip
 *   dist/rp-drh-mcp-linux-x64/     →  dist/rp-drh-mcp-linux-x64.zip
 *
 * Pure-JS via adm-zip — no `zip` (bash) or `Compress-Archive` (PowerShell)
 * host dependency. Same behavior on every host that runs Bun.
 *
 * Ships the real `.env` alongside `.env.example` — internal distribution,
 * zero-config on extract. Sets +x on the binary and the launcher inside the zip on unix
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

// Stamp the build into the zip name — rp-<x>-mcp-linux-x64_6.53.zip. Same
// reason the docker bundle does it: a rep with two downloads can tell which is
// which, and "what version are you on?" is answerable from the filename. This
// matters here specifically because the shipped binaries went stale for two
// weeks with nothing in the name to say so.
//
// The BINARY inside keeps its stable name on purpose: the launcher scripts and
// the Dockerfile COPY reference it by name, and an MCP client config pointing at
// the binary path would break on every version bump.
const version = (
  JSON.parse(
    readFileSync(join(pkgRoot, "..", "shared", "version.json"), "utf8"),
  ) as { version: string }
).version;

if (!existsSync(dst)) {
  console.error(`[release-zip] dist/ not found at ${dst} — run \`bun run build:all\` first.`);
  process.exit(1);
}

// Per-platform subdirs follow the rp-drh-mcp-<platform>/ naming convention.
const platforms = readdirSync(dst, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("rp-drh-mcp-"))
  .map((e) => e.name)
  .sort();

if (platforms.length === 0) {
  console.error(`[release-zip] No platform subdirs in ${dst} — run \`bun run build:all\` first.`);
  process.exit(1);
}

// Files always excluded from release zips:
// Nothing is excluded: the shipped .env is REAL and deliberate. These zips go
// to internal reps, never a public registry, and the whole point is a folder
// that runs on double-click. The .env is derived from .env.example's key list
// (see copy-dist-templates.ts), so dev-only secrets cannot ride along.
const EXCLUDE = new Set<string>();

// Entries are added at the ZIP ROOT (bare basenames), never under a
// `<platform>/` prefix. Windows "Extract All" already creates a folder named
// after the zip, so an internal folder yields
// rp-x-mcp-linux-x64_6.53\rp-x-mcp-linux-x64\... — the double-folder the
// docker bundle hit and fixed the same way. It also keeps the quick-start's
// "open the extracted folder and you'll see the binary" literally true.

// Files that should be marked executable inside the zip on unix platforms.
function shouldBeExecutable(platformDir: string, fileName: string): boolean {
  if (platformDir.startsWith("rp-drh-mcp-windows")) return false;
  if (fileName.startsWith("rp-drh-mcp-")) return true; // the binary
  if (fileName.endsWith(".sh")) return true;
  if (fileName.endsWith(".command")) return true;
  return false;
}

let zipped = 0;
const summary: Array<{ name: string; bytes: number; entries: number }> = [];

for (const platform of platforms) {
  const subdir = join(dst, platform);
  // Zip name is derived from, but not identical to, the platform DIRECTORY.
  // The directory keeps its rp-<x>-mcp-<platform> name because both Dockerfiles
  // COPY the binary out of it; only the shipped artifact gets the family naming:
  //
  //   _rp-ai_web_docker-container_6.54.zip    <- full stack (docker bundle)
  //   _rp-rpi_mcp-server_linux-x64_6.54.zip   <- standalone
  //   _rp-drh_mcp-server_windows-x64_6.54.zip <- standalone
  //
  // Leading underscore top-sorts them in Explorer, `_`-separated segments and a
  // dotted version match across all three, and "mcp-server" says what it is when
  // it is sitting next to the web bundle.
  const zipBase = platform.replace(/^rp-(rpi|drh)-mcp-/, "_rp-$1_mcp-server_");
  const zipPath = join(dst, `${zipBase}_${version}.zip`);

  // Stale zip from a prior run gets replaced (don't append to a partial).
  if (existsSync(zipPath)) unlinkSync(zipPath);

  const zip = new AdmZip();
  let entryCount = 0;

  for (const entry of readdirSync(subdir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (EXCLUDE.has(entry.name)) continue;

    const filePath = join(subdir, entry.name);
    const data = readFileSync(filePath);
    zip.addFile(entry.name, data); // ROOT-LEVEL — see note above

    if (shouldBeExecutable(platform, entry.name)) {
      // adm-zip stores a single 32-bit `attr` field combining DOS attrs
      // (lower 16) and unix mode (upper 16). 0o755 << 16 sets +rwxr-xr-x.
      const zipEntry = zip.getEntry(entry.name);
      if (zipEntry) zipEntry.attr = (0o755 << 16) | 0;
    }

    entryCount += 1;
  }

  zip.writeZip(zipPath);
  const { size } = statSync(zipPath);
  summary.push({ name: `${zipBase}_${version}.zip`, bytes: size, entries: entryCount });
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
