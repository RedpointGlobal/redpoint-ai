/**
 * build:bundle — produce the prebuilt "double-click" docker-container bundle
 * (internal artifact, not a public getting-started path):
 *
 *   dist/_rp-ai_web_docker-container_<ver>.zip
 *
 * Steps: build the 4 service images at the current version, `docker save` them into
 * rp-ai-images.tar, assemble the bundle from packaging/docker-bundle/ (stamping the
 * version and baking the REAL .env from the operator's local gitignored root .env),
 * and pack a ROOT-LEVEL zip via adm-zip.
 *
 * Design notes:
 *   - Pure-JS zip via adm-zip (same as packages/mcp-rpi/scripts/release-zip.ts) — no
 *     host `zip`/`Compress-Archive` dependency.
 *   - Entries are added at the ZIP ROOT (basename, no folder prefix) so Windows
 *     "Extract All" yields ONE folder named after the zip — never a double-nested
 *     _rp-ai_docker-container_<ver>/_rp-ai_docker-container_<ver>/.
 *   - The real .env (sandbox creds) is baked from ./.env at build time and is never
 *     committed; the repo ships only packaging/docker-bundle/.env.example.
 *
 * Run: `bun run build:bundle`  (requires Docker running + a filled-in ./.env)
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import archiver from "archiver";

const repoRoot = join(import.meta.dir, "..");
const distDir = join(repoRoot, "dist");
const tmplDir = join(repoRoot, "packaging", "docker-bundle");

// Version is the manually-stamped MAJOR.MINOR in packages/shared/version.json — the
// single source of truth (also read by apps/web Config tab and the server /health).
const version = (
  JSON.parse(readFileSync(join(repoRoot, "packages", "shared", "version.json"), "utf8")) as {
    version: string;
  }
).version;
// Artifact name: _rp-ai_web_docker-container_<ver>.zip. Both halves earn their
// place - `web` is the entity (the full stack a rep opens in a browser) and
// `docker-container` is the delivery form, which is what distinguishes it from
// the standalone binaries when a rep has all five zips in one folder:
//   _rp-ai_web_docker-container_6.56.zip      <- full stack, prebuilt images
//   _rp-rpi_mcp-server_linux-x64_6.56.zip     <- standalone binary
//   _rp-drh_mcp-server_windows-x64_6.56.zip   <- standalone binary
// The leading underscore keeps it top-sorted in Explorer, which is the one a rep
// wants first.
//
// The version is dotted, matching the MCP zips and packages/shared/version.json
// itself. It used to be slugged to 6-54; in a shared folder that read as a
// different numbering scheme from the binaries sitting beside it.

// The bundle bakes creds by DIRECT COPY of the single source of truth — the dev's
// root .env. The bundle runs all four services, so it legitimately needs every
// key. Dev-only tooling secrets (SEMGREP_*) live in the shell, not root .env, so a
// direct copy is clean. COMPOSE_PROJECT_NAME=redpointai MUST be in root .env: the
// launchers' ours-identity sweep keys on label=com.docker.compose.project, so a
// bundle lacking it would name containers after the extraction folder and the
// cleanup would stop recognizing our own stack.
const envSrc = join(repoRoot, ".env");
if (!existsSync(envSrc)) {
  console.error(
    "[build:bundle] ERROR: no populated root .env\n" +
      "  - copy .env.example -> .env\n" +
      "  - fill in your RPI / DRH / LLM values (and COMPOSE_PROJECT_NAME=redpointai)\n" +
      "  - re-run:  bun run build:bundle\n" +
      "Refusing to build a credential-less bundle.",
  );
  process.exit(1);
}

const services = [
  { name: "server", df: "apps/server/Dockerfile" },
  { name: "web", df: "apps/web/Dockerfile" },
  { name: "mcp-rpi", df: "packages/mcp-rpi/Dockerfile" },
  { name: "mcp-drh", df: "packages/mcp-drh/Dockerfile" },
];

// 1. Build the 4 images from committed Dockerfiles (context = repo root).
for (const s of services) {
  const tag = `rp-ai-${s.name}:${version}`;
  console.log(`\n[build:bundle] building ${tag} ...`);
  execSync(`docker build -f "${s.df}" -t "${tag}" .`, { cwd: repoRoot, stdio: "inherit" });
}

// 2. Assemble a scratch staging dir.
const stage = mkdtempSync(join(tmpdir(), "rpai-bundle-"));
try {
  // Text templates: substitute the version placeholder.
  const textFiles = [
    "docker-compose.yml",
    "start_redpoint-ai.bat",
    "stop_redpoint-ai.bat",
    "_rp-ai_quick-start_docker-container.txt",
  ];
  for (const f of textFiles) {
    const txt = readFileSync(join(tmplDir, f), "utf8").replaceAll("__VERSION__", version);
    writeFileSync(join(stage, f), txt);
  }
  // Direct copy of the single source of truth (root .env). The bundle runs all four
  // services, so it needs every key — no whitelist. Guard the one launcher-critical
  // key: COMPOSE_PROJECT_NAME must be present, or the ours-identity container sweep
  // can't recognize our own stack.
  const rootEnvText = readFileSync(envSrc, "utf8");
  if (!/^\s*COMPOSE_PROJECT_NAME=redpointai\s*(#.*)?$/m.test(rootEnvText)) {
    console.error(
      "[build:bundle] ERROR: root .env is missing COMPOSE_PROJECT_NAME=redpointai.\n" +
        "  The launcher's ours-identity container sweep keys on the compose project label;\n" +
        "  without it the bundle names containers after the extraction folder and cleanup breaks.\n" +
        "  Add `COMPOSE_PROJECT_NAME=redpointai` to root .env and re-run.",
    );
    process.exit(1);
  }
  writeFileSync(join(stage, ".env"), rootEnvText);

  // 3. docker save the 4 images into the bundle tar.
  const tags = services.map((s) => `rp-ai-${s.name}:${version}`).join(" ");
  const tarPath = join(stage, "rp-ai-images.tar");
  console.log(`\n[build:bundle] docker save -> rp-ai-images.tar ...`);
  execSync(`docker save -o "${tarPath}" ${tags}`, { stdio: "inherit" });

  // 4. Pack a ROOT-LEVEL zip with a STREAMING writer (archiver, store mode). Streaming
  //    keeps memory constant regardless of the ~1.3 GB images tar — adm-zip buffered the
  //    whole archive in memory and OOM'd (ENOMEM) on it. store:true skips deflate (the
  //    tar is already incompressible). Entries are added with name = basename, so they
  //    land at the ZIP ROOT (Windows "Extract All" -> one folder, never double-nested).
  const zipName = `_rp-ai_web_docker-container_${version}.zip`;
  const zipPath = join(distDir, zipName);
  // dist/ is gitignored, so a fresh clone has none — createWriteStream(zipPath) would ENOENT.
  // The warm working repo masks this because dist/ already exists there; a maintainer running
  // build:bundle on a clean checkout hit it. Create it before writing.
  mkdirSync(distDir, { recursive: true });
  if (existsSync(zipPath)) rmSync(zipPath);
  const bundleFiles = [
    ".env",
    "docker-compose.yml",
    "start_redpoint-ai.bat",
    "stop_redpoint-ai.bat",
    "_rp-ai_quick-start_docker-container.txt",
    "rp-ai-images.tar",
  ];
  console.log(`\n[build:bundle] packing ${zipName} ...`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { store: true });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const f of bundleFiles) archive.file(join(stage, f), { name: f }); // name = basename -> zip ROOT
    void archive.finalize();
  });

  // 5. Verify: the zip must be at least as large as the images tar it wraps (sanity that
  //    the big entry streamed all the way through). Root-level is guaranteed by construction
  //    (name = basename above). A full CRC check is run externally as the ship gate.
  const tarBytes = statSync(join(stage, "rp-ai-images.tar")).size;
  const zipBytes = statSync(zipPath).size;
  console.log(
    `\n[build:bundle] wrote dist/${zipName}  (${(zipBytes / 1024 / 1024).toFixed(0)} MB, ${bundleFiles.length} files, root-level)`,
  );
  if (zipBytes < tarBytes) {
    console.error(
      `[build:bundle] ERROR: zip (${zipBytes} B) smaller than the images tar (${tarBytes} B) — incomplete write.`,
    );
    process.exit(1);
  }
  // 6. Sweep this machine's older rp-ai-* images. Each build tags 4 more, and
  //    nothing else prunes them here: the launcher's prune only ever runs on the
  //    machine running the bundle, never on the build box. Left alone they pile
  //    up one set (~4.5 GB) per version — 9 builds had grown to 36 images /
  //    ~90 GB before this was noticed. Same predicate the launcher uses: keep
  //    exactly the version just built, drop every other rp-ai-* tag. Nothing is
  //    lost, since any prior version reloads from its own zip via `docker load`.
  const stale = execSync(
    'docker images --filter "reference=rp-ai-*" --format "{{.Repository}}:{{.Tag}}"',
    { encoding: "utf8" },
  )
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t && !t.endsWith(`:${version}`));
  if (stale.length) {
    for (const tag of stale) {
      try {
        execSync(`docker rmi "${tag}"`, { stdio: "ignore" });
      } catch {
        // An image still referenced by a container is fine to leave behind.
      }
    }
    console.log(
      `[build:bundle] pruned ${stale.length} older rp-ai-* image tag(s), keeping :${version}`,
    );
  }

  // 6b. Sweep stale scratch EXTRACTION dirs in dist/ (never the deliverable zip).
  //     The smokes themselves extract to the OS temp dir, not here — but MANUALLY
  //     extracting a bundle zip to run start.bat (dist/_run_*, dist/_smoke_bundle_run)
  //     leaves multi-GB folders behind. Scoped to our scratch prefixes so a real
  //     artifact (the *.zip, or anything a user parked here) is never touched.
  try {
    for (const name of readdirSync(distDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      if (/^_run_|^_smoke/.test(name.name)) {
        rmSync(join(distDir, name.name), { recursive: true, force: true });
        console.log(`[build:bundle] swept stale dist scratch dir: ${name.name}`);
      }
    }
  } catch {
    /* dist/ may not exist on a first run — nothing to sweep */
  }

  // 7. Smoke the freshly-built bundle through the REP PATH — the WEB entry point
  //    (web→server→mcp→rpi), authed when the baked .env ships auth=true.
  //
  //    ENGINE CAVEAT (why this is NOT a hard gate by default): this smoke stands up
  //    the bundle stack on whatever docker engine build:bundle is run against. The
  //    bundle SHIPS to and RUNS on Windows Docker Desktop, but a build host may have
  //    a separate WSL-native docker engine whose container network CANNOT route to a
  //    private backend subnet (e.g. an on-prem RPI on a 10.x VPN address). On such a
  //    host the smoke false-fails with `mcp_unavailable` even though the bundle is
  //    fine on Docker Desktop — so a wrong-engine smoke must NEVER block the release.
  //    The AUTHORITATIVE rep-path gate is running start_redpoint-ai.bat on Docker
  //    Desktop (the rep's actual runtime) and driving the web UI, or running
  //    scripts/smoke-bundle.ts with SMOKE_DOCKER=docker.exe + SMOKE_NO_LIFECYCLE=1
  //    against that launched stack.
  //
  //    Default: run the smoke for its diagnostics but treat a failure as a WARNING,
  //    not a build failure. SMOKE_BUNDLE_STRICT=1 restores the hard gate (exit 1) —
  //    use it only on a host whose docker engine can actually reach the backends
  //    (e.g. Docker Desktop, pinned via SMOKE_DOCKER=docker.exe). SMOKE_BUNDLE_SKIP=1
  //    skips it entirely. SMOKE_DOCKER is forwarded so the engine can be pinned.
  if (process.env.SMOKE_BUNDLE_SKIP === "1") {
    console.warn(
      "\n[build:bundle] bundle smoke SKIPPED (SMOKE_BUNDLE_SKIP=1) — the rep-path web→server→mcp→rpi chain was NOT verified for this zip. Verify via start_redpoint-ai.bat on Docker Desktop.",
    );
  } else {
    const strict = process.env.SMOKE_BUNDLE_STRICT === "1";
    // The compose bind-mounts ./instrumentation relative to its own dir (the stage).
    mkdirSync(join(stage, "instrumentation"), { recursive: true });
    console.log(
      `\n[build:bundle] smoking the bundle through the web entry point (rep path)${strict ? " [STRICT]" : ""} ...`,
    );
    const smoke = spawnSync("bun", ["run", join(repoRoot, "scripts", "smoke-bundle.ts")], {
      cwd: stage,
      stdio: "inherit",
      env: {
        ...process.env,
        SMOKE_COMPOSE_FILE: join(stage, "docker-compose.yml"),
        SMOKE_ENV_FILE: join(stage, ".env"),
        SMOKE_PROJECT: "rpai-bundle-smoke",
      },
    });
    if (smoke.status !== 0) {
      if (strict) {
        console.error(
          "[build:bundle] ERROR: bundle smoke FAILED (SMOKE_BUNDLE_STRICT) — refusing to trust this bundle.",
        );
        process.exit(1);
      }
      console.warn(
        "\n[build:bundle] WARNING: bundle smoke did NOT pass on this build engine. If this host's docker cannot reach the backends (e.g. a WSL-native engine vs a private RPI subnet), this is a FALSE failure — the bundle is still produced. Verify the rep path AUTHORITATIVELY via start_redpoint-ai.bat on Docker Desktop before shipping. (Re-run with SMOKE_BUNDLE_STRICT=1 on a backend-reachable engine to hard-gate.)",
      );
    }
  }

  console.log("[build:bundle] OK.");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
