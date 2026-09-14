/**
 * env-scopes — single source of truth for per-artifact environment scoping.
 *
 * The root `.env` is the deployment's full-superset vault (gitignored; carries
 * real values). It is organized into `#@scope:` blocks that declare which
 * artifact each var belongs to. From those tags this module derives, with no
 * hand-maintained parallel list (kills drift):
 *
 *   1. the committed root `.env.example`  — ALL vars, tamed + commented, secret
 *      VALUES empty, hosts genericized (the deployer / OSS-reader artifact);
 *   2. the per-binary scoped templates      — mcp-rpi gets AUTH_REQUIRED + RPI_*,
 *      mcp-drh gets AUTH_REQUIRED + DRH_*, secrets empty (bundled in each zip);
 *   3. a build-check                         — orphan/leak/cross-scope guard.
 *
 * Secrets never reach a committed or shipped artifact: this module NEVER copies
 * a real value into an output. `.env.example` values come from EXAMPLE_VALUES
 * (authored generics / safe defaults / empty); binary templates reuse them.
 * The real root `.env` is read only for its STRUCTURE (keys, scope tags, order,
 * comments) — never its values — so a real secret cannot leak through here.
 *
 * The pure functions (parse / render / check) take text and return data, so the
 * full matrix is unit-testable with no filesystem or live deps. The CLI at the
 * bottom does the I/O and the code-read grep.
 */

/** Artifact scopes a var may be tagged with. `container` = docker-compose/runtime, not app code. */
export const ALLOWED_SCOPES = ["hosted-app", "mcp-rpi", "mcp-drh", "container"] as const;
export type Scope = (typeof ALLOWED_SCOPES)[number];

/** The 🔑 real secrets — their VALUE must never appear in any committed/shipped artifact. */
export const SECRET_KEYS = new Set([
  "AUTH_SECRET",
  "AZURE_OPENAI_API_KEY",
  "RPI_OAUTH_CLIENT_SECRET",
  "RPI_PROXY_PASS",
  "DRH_PROXY_PASS",
]);

/**
 * Keys consumed OUTSIDE the TS code (docker-compose / container runtime), so a
 * "no app-code read" check must NOT flag them as orphaned/removable.
 */
export const CONTAINER_CONSUMED_KEYS = new Set(["COMPOSE_PROJECT_NAME"]);

/**
 * Container VALUE-OVERRIDE keys — the ONLY keys the bundle docker-compose.yml is
 * allowed to set in a service `environment:` block that aren't already in the
 * root .env superset. Each is a genuine container-network delta: reach a peer by
 * its compose SERVICE NAME instead of localhost, a container port, or a
 * container filesystem path. Every one has a code default (so a local `bun run
 * dev`, which never loads this compose, is unaffected); the container overrides
 * the VALUE only. This map is the documented allowlist the build-check enforces:
 * compose may override these values, but it may introduce NO other key that isn't
 * in the superset — that is exactly how "AUTH_REQUIRED=false hidden in compose"
 * slipped in and diverged the container from the auth=true source of truth.
 */
export const COMPOSE_OVERRIDE_KEYS: Record<string, string> = {
  PORT: "server listen port inside the container",
  SEED_RPI_MCP_URL: "reach the RPI MCP by compose service name (http://mcp-rpi:3002/mcp)",
  DRH_MCP_URL: "reach the DRH MCP by compose service name (http://mcp-drh:3003/mcp)",
  DB_FILE_NAME: "SQLite path on the named volume (/app/data/redpoint-ai.db)",
  INSTRUMENTATION_SINK_PATH: "instrumentation JSONL on the host bind-mount",
  NEXT_PUBLIC_API_URL: "web→server by compose service name (http://server:3000)",
  AUTH_TRUST_HOST: "NextAuth trusts the proxied Host for the callback origin",
  RPI_MCP_HTTP_PORT: "RPI MCP listen port inside the container",
  DRH_MCP_HTTP_PORT: "DRH MCP listen port inside the container",
};

/**
 * Authored example values for the generated `.env.example` + binary templates.
 * Secrets → "" (empty). Hosts/tenants/emails → genericized. Safe booleans /
 * versions / model / fixed identity → their non-sensitive default. A key absent
 * here renders empty. Real root values are NEVER used — this is the only source
 * of output values, so no live secret can leak.
 */
export const EXAMPLE_VALUES: Record<string, string> = {
  AUTH_REQUIRED: "true",
  AUTH_SECRET: "",
  AZURE_OPENAI_API_KEY: "",
  AZURE_OPENAI_RESOURCE_NAME: "your-resource-name",
  AZURE_OPENAI_DEPLOYMENT_ID: "gpt-4.1",
  AZURE_OPENAI_API_VERSION: "2024-10-01-preview",
  COMPOSE_PROJECT_NAME: "redpointai",
  DRH_API_URL: "https://drh.example.com",
  DRH_DEFAULT_CLIENT_ID: "",
  DRH_DEFAULT_DATABASE_ID: "",
  DRH_PROXY_ENABLED: "true",
  DRH_PROXY_PASS: "",
  DRH_PROXY_USER: "",
  INSTRUMENTATION_ENABLED: "false",
  INSTRUMENTATION_USER_ID: "you@example.com",
  // Non-secret URL. Generic default = the standard localhost callback (OSS-safe).
  // It MUST equal the root .env value so the leak-gate's safe-generic exclusion
  // covers the http:// value (else the ^https?:// shape would false-flag it).
  RPI_AI_AGENT_REDIRECT_URL: "http://localhost:3001/api/auth/callback/sso",
  RPI_DEFAULT_CLIENT_ID: "",
  RPI_INTEGRATION_API_URL: "https://rpi.example.com",
  RPI_OAUTH_CLIENT_ID: "",
  RPI_OAUTH_CLIENT_SECRET: "",
  RPI_PROXY_ENABLED: "true",
  RPI_PROXY_USER: "",
  RPI_PROXY_PASS: "",
  RPI_URL_ALLOWLIST: "",
};

export interface EnvVarDef {
  key: string;
  scopes: Scope[];
  /** One-line purpose comment (from the preceding `#` line or inline `# …`). */
  comment: string;
  /** Real value as read from the source — used ONLY for parity/leak checks, never rendered. */
  rawValue: string;
  lineNo: number;
  secret: boolean;
}

export interface ParseResult {
  vars: EnvVarDef[];
  errors: string[];
}

const KV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const SCOPE_RE = /^#@scope:\s*(.*)$/;

/**
 * Parse scope-tagged env text. A `#@scope:` line sets the active scope list for
 * every var line that follows, until the next `#@scope:`. A var line with no
 * active scope is an ORPHAN error. Unknown scope names are errors. A preceding
 * plain `#` comment line (or an inline `# …`) becomes the var's comment.
 */
export function parseScopedEnv(text: string): ParseResult {
  const vars: EnvVarDef[] = [];
  const errors: string[] = [];
  let active: Scope[] | null = null;
  // Consecutive preceding `#` lines accumulate into one multi-line comment, so a
  // block note (e.g. the proxy "do I need this?" note) attaches to the var it
  // precedes and propagates to every rendered output.
  let pendingComments: string[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const scopeM = line.match(SCOPE_RE);
    if (scopeM) {
      const names = scopeM[1].split(",").map((s) => s.trim()).filter(Boolean);
      const bad = names.filter((n) => !ALLOWED_SCOPES.includes(n as Scope));
      if (names.length === 0) errors.push(`line ${lineNo}: empty #@scope tag`);
      if (bad.length) errors.push(`line ${lineNo}: unknown scope(s): ${bad.join(", ")}`);
      active = names.filter((n) => ALLOWED_SCOPES.includes(n as Scope)) as Scope[];
      pendingComments = [];
      return;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      // Accumulate consecutive comment lines into the next var's (multi-line) comment.
      pendingComments.push(trimmed.replace(/^#+\s?/, ""));
      return;
    }
    if (trimmed === "") {
      pendingComments = [];
      return;
    }
    const kv = line.match(KV_RE);
    if (!kv) return; // not a var line (defensive)
    const key = kv[1];
    let rest = kv[2];
    let inlineComment = "";
    const hashIdx = rest.indexOf(" #");
    if (hashIdx >= 0) {
      inlineComment = rest.slice(hashIdx + 2).trim();
      rest = rest.slice(0, hashIdx);
    }
    const comment = inlineComment || pendingComments.join("\n");
    pendingComments = [];
    if (active === null) {
      errors.push(`line ${lineNo}: var ${key} has no #@scope: block (orphan/untagged)`);
    }
    vars.push({
      key,
      scopes: active ?? [],
      comment,
      rawValue: rest.trim(),
      lineNo,
      secret: SECRET_KEYS.has(key),
    });
  });

  return { vars, errors };
}

/** The example (never-real) value a var renders with in any output. */
export function exampleValue(key: string): string {
  return EXAMPLE_VALUES[key] ?? "";
}

/** Commented alt-provider placeholders preserved verbatim in the generated root .env.example. */
export const ALT_PROVIDER_BLOCK = `# --- Alternative LLM providers (placeholders — the seed picks by key presence: Azure -> Anthropic -> OpenAI) ---
# Provider and model come from this file; the seed rewrites each workspace on every boot.
# ANTHROPIC_API_KEY=sk-ant-...          # ANTHROPIC_MODEL overrides the model (default claude-sonnet-4-6)
# OPENAI_API_KEY=sk-...                 # OPENAI_MODEL overrides the model (default gpt-4o)
# GOOGLE_GENERATIVE_AI_API_KEY=...      # wired in the provider factory but NOT env-selectable`;

const SECRET_MARKER = "  (secret — leave empty here)";

function renderVar(v: EnvVarDef): string {
  const lines: string[] = [];
  // Idempotent: strip any prior marker so re-rendering an already-rendered
  // template (binary templates are derived from the rendered .env.example)
  // never doubles it. Multi-line comments render one `#` line each; the secret
  // marker goes on the LAST line only.
  const comment = v.comment.replace(/\s*\(secret — leave empty here\)/g, "").trimEnd();
  if (comment) {
    const cl = comment.split("\n");
    cl.forEach((ln, i) => {
      const last = i === cl.length - 1;
      lines.push(`# ${ln}${last && v.secret ? SECRET_MARKER : ""}`);
    });
  }
  lines.push(`${v.key}=${exampleValue(v.key)}`);
  return lines.join("\n");
}

/**
 * Render the committed root `.env.example`: every var, grouped by its scope
 * block, comments preserved, secret values empty, hosts genericized, plus the
 * commented alt-provider block. Secret values are ALWAYS empty by construction.
 */
export function renderEnvExample(vars: EnvVarDef[]): string {
  const header = `# RedpointAI — environment template (generated from the tamed root .env by scripts/env-scopes.ts)
# Copy to .env and fill in your values. Secrets are 🔑 (shown empty here).
# #@scope: tags declare which artifact each block belongs to (hosted-app / mcp-rpi / mcp-drh / container).
# Regenerate with: bun run gen:env
`;
  // Group by identical scope-tag signature, preserving first-seen order.
  const blocks: { sig: string; scopes: Scope[]; vars: EnvVarDef[] }[] = [];
  for (const v of vars) {
    const sig = v.scopes.join(",");
    let b = blocks.find((x) => x.sig === sig);
    if (!b) {
      b = { sig, scopes: v.scopes, vars: [] };
      blocks.push(b);
    }
    b.vars.push(v);
  }
  const body = blocks
    .map((b) => `#@scope: ${b.scopes.join(", ")}\n${b.vars.map(renderVar).join("\n\n")}`)
    .join("\n\n");
  return `${header}\n${body}\n\n${ALT_PROVIDER_BLOCK}\n`;
}

/** Vars belonging to a given scope (multi-scope vars match each of their scopes). */
export function sliceForScope(vars: EnvVarDef[], scope: Scope): EnvVarDef[] {
  return vars.filter((v) => v.scopes.includes(scope));
}

/**
 * Render a per-binary scoped `.env.example` (bundled in the zip). Only the given
 * scope's vars, secrets empty. Cross-scope keys are absent by construction.
 */
export function renderBinaryTemplate(vars: EnvVarDef[], scope: Scope, title: string): string {
  const slice = sliceForScope(vars, scope);
  const header = `# ${title} — standalone distribution
# Copy this file to \`.env\` in the same folder as the binary, then fill in your values.
# This template carries ONLY the keys this server uses (least privilege); secrets are empty.
`;
  return `${header}\n${slice.map(renderVar).join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Build-check — pure logic, unit-testable. The CLI injects codeReads (grep).
// ---------------------------------------------------------------------------

export interface BuildCheckInput {
  /** Parsed scope source (root .env or committed .env.example). */
  vars: EnvVarDef[];
  parseErrors: string[];
  /** Rendered committed/shipped artifacts to scan for leaked secret values, keyed by name. */
  artifacts: Record<string, string>;
  /** Per-scope set of keys actually read by that artifact's code (from grep). Optional. */
  codeReads?: Partial<Record<Scope, Set<string>>>;
  /** The full superset key set expected (for union==superset). Defaults to vars' keys. */
  supersetKeys?: Set<string>;
  /**
   * Real SENSITIVE values from the gitignored vault (secrets, hosts, GUIDs,
   * emails) — injected at check-time by the CLI, never hardcoded in committed
   * source. The hard gate: none of these may appear ANYWHERE in a public
   * artifact. Safe literals (true/false/gpt-4.1/…) are excluded by the CLI.
   */
  sensitiveValues?: Set<string>;
}

export interface BuildCheckResult {
  errors: string[];
  warnings: string[];
}

/** A value that looks like a real secret (non-empty, not a known-safe placeholder). */
function looksLikeRealSecretValue(v: string): boolean {
  const t = v.trim();
  if (t === "") return false;
  return true; // any non-empty value for a SECRET key in an output is a leak
}

export function runBuildCheck(input: BuildCheckInput): BuildCheckResult {
  const errors: string[] = [...input.parseErrors];
  const warnings: string[] = [];

  // 1. Every var is tagged (parseScopedEnv already emits orphan errors); also
  //    every var must resolve to >=1 known scope.
  for (const v of input.vars) {
    if (v.scopes.length === 0) {
      errors.push(`var ${v.key} belongs to no #@scope block (orphan)`);
    }
  }

  // 2. No real secret VALUE baked into any committed/shipped artifact.
  //    Parse each artifact and assert every SECRET_KEYS line is empty.
  for (const [name, text] of Object.entries(input.artifacts)) {
    const parsed = parseArtifactKV(text);
    for (const [key, val] of parsed) {
      if (SECRET_KEYS.has(key) && looksLikeRealSecretValue(val)) {
        errors.push(`artifact ${name}: secret ${key} carries a VALUE (must be empty) — leak`);
      }
    }
  }

  // 2b. HARD GATE (defense-in-depth): no real sensitive VALUE from the vault may
  //     appear anywhere in a public artifact — catches leaked secrets AND hosts /
  //     GUIDs / emails, even if a value slipped past the empty-secret check.
  if (input.sensitiveValues) {
    for (const [name, text] of Object.entries(input.artifacts)) {
      for (const val of input.sensitiveValues) {
        if (val && text.includes(val)) {
          errors.push(`artifact ${name}: contains a real sensitive value from the vault — leak (redacted)`);
          break; // one report per artifact; never echo the value
        }
      }
    }
  }

  // 3. No cross-scope KEYS in a binary artifact. Enforced by naming convention:
  //    an artifact named "mcp-rpi*" must contain no DRH_/AZURE_/AUTH_SECRET keys;
  //    "mcp-drh*" no RPI_/AZURE_/AUTH_SECRET keys.
  for (const [name, text] of Object.entries(input.artifacts)) {
    const keys = parseArtifactKV(text).map(([k]) => k);
    const scopeOfArtifact: Scope | null = name.includes("mcp-rpi")
      ? "mcp-rpi"
      : name.includes("mcp-drh")
        ? "mcp-drh"
        : null;
    if (!scopeOfArtifact) continue;
    const allowed = new Set(
      sliceForScope(input.vars, scopeOfArtifact).map((v) => v.key),
    );
    for (const k of keys) {
      if (!allowed.has(k)) {
        errors.push(`artifact ${name}: contains cross-scope key ${k} (not in ${scopeOfArtifact} scope)`);
      }
    }
  }

  // 4. Under-scoping warning: code in an artifact reads a var its scope doesn't
  //    include. Container-consumed keys are whitelisted (no app-code read).
  if (input.codeReads) {
    for (const scope of ALLOWED_SCOPES) {
      const reads = input.codeReads[scope];
      if (!reads) continue;
      const inScope = new Set(sliceForScope(input.vars, scope).map((v) => v.key));
      for (const key of reads) {
        if (CONTAINER_CONSUMED_KEYS.has(key)) continue;
        if (!inScope.has(key)) {
          warnings.push(`under-scoped: ${scope} code reads ${key} but it is not tagged for ${scope}`);
        }
      }
    }
  }

  // 5. Container-consumed keys must NOT be flagged as orphans just for lacking a
  //    code read — they carry the `container` scope. Assert they are tagged.
  for (const key of CONTAINER_CONSUMED_KEYS) {
    const v = input.vars.find((x) => x.key === key);
    if (v && !v.scopes.includes("container") && !v.scopes.includes("hosted-app")) {
      warnings.push(`container/compose key ${key} should carry a container (or hosted-app) scope`);
    }
  }

  // 6. Invariant: union of scoped slices == the full superset (nothing dropped/invented).
  const superset = input.supersetKeys ?? new Set(input.vars.map((v) => v.key));
  const union = new Set<string>();
  for (const scope of ALLOWED_SCOPES) {
    for (const v of sliceForScope(input.vars, scope)) union.add(v.key);
  }
  for (const k of superset) {
    if (!union.has(k)) errors.push(`invariant: ${k} is in the superset but no scope slice contains it`);
  }
  for (const k of union) {
    if (!superset.has(k)) errors.push(`invariant: ${k} appears in a scope slice but not the superset`);
  }

  return { errors, warnings };
}

/**
 * Guard the bundle docker-compose.yml against config drift: every key set in a
 * service `environment:` block must be either in the .env superset (interpolated
 * / matched by name) or a documented COMPOSE_OVERRIDE_KEYS value-override. A key
 * that is NEITHER is config hidden only in compose — the exact failure that let
 * AUTH_REQUIRED=false diverge the container from the auth=true source of truth.
 * Also fails if compose hardcodes a key that the superset owns but that is NOT a
 * sanctioned value-override (e.g. re-introducing AUTH_REQUIRED here).
 */
export function checkComposeEnv(
  composeText: string,
  supersetKeys: Set<string>,
): string[] {
  const errors: string[] = [];
  // Pull `- KEY=...` lines that sit under an `environment:` block. The bundle
  // compose lists them as `- KEY=value`; we only need the KEY.
  const keys: string[] = [];
  let inEnv = false;
  for (const line of composeText.split(/\r?\n/)) {
    if (/^\s{4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    // A new same-or-shallower key ends the environment block.
    if (inEnv && /^\s{4}\S/.test(line) && !/^\s{6,}-/.test(line)) inEnv = false;
    if (inEnv) {
      const m = line.match(/^\s+-\s+([A-Za-z_][A-Za-z0-9_]*)=/);
      if (m) keys.push(m[1]);
    }
  }
  for (const k of keys) {
    const sanctioned =
      k in COMPOSE_OVERRIDE_KEYS ||
      CONTAINER_CONSUMED_KEYS.has(k) ||
      supersetKeys.has(k);
    if (!sanctioned) {
      errors.push(
        `docker-compose.yml: environment key ${k} is not in the .env superset nor a documented COMPOSE_OVERRIDE_KEYS override — config hidden only in compose`,
      );
    }
    // A superset key hardcoded in compose that isn't a sanctioned value-override
    // is drift (it silently diverges from .env). AUTH_REQUIRED is the canonical
    // example — it must come from .env (env_file), never be hardcoded here.
    if (supersetKeys.has(k) && !(k in COMPOSE_OVERRIDE_KEYS)) {
      errors.push(
        `docker-compose.yml: environment key ${k} is a superset key hardcoded in compose (not a sanctioned override) — it must come from .env via env_file, not be pinned here`,
      );
    }
  }
  return errors;
}

/** Minimal KEY=VALUE extractor for scanning an already-rendered artifact. */
export function parseArtifactKV(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = line.match(KV_RE);
    if (!m) continue;
    let val = m[2];
    const hashIdx = val.indexOf(" #");
    if (hashIdx >= 0) val = val.slice(0, hashIdx);
    out.push([m[1], val.trim()]);
  }
  return out;
}

/**
 * Extract the SENSITIVE real values from a raw root .env text — secrets plus
 * anything shaped like a host / GUID / email — so the build-check can assert none
 * leak into a public artifact. Safe literals (booleans, versions, model names,
 * the fixed compose identity) are excluded because they legitimately appear.
 */
export function sensitiveValuesFrom(rawEnvText: string): Set<string> {
  const out = new Set<string>();
  const SENSITIVE_SHAPE = /(^https?:\/\/)|([0-9a-f]{8}-[0-9a-f]{4})|(@)/i;
  // A real value that equals a known-safe generic (e.g. INSTRUMENTATION_USER_ID
  // already set to you@example.com) is NOT a leak — exclude the generics so the
  // gate doesn't false-positive on them appearing (legitimately) in outputs.
  const safeGenerics = new Set(Object.values(EXAMPLE_VALUES).filter(Boolean));
  for (const [key, val] of parseArtifactKV(rawEnvText)) {
    if (!val || safeGenerics.has(val)) continue;
    if (SECRET_KEYS.has(key) || SENSITIVE_SHAPE.test(val)) out.add(val);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI — I/O + grep (impure). `gen` writes the committed root .env.example;
// `check` runs the build-check gate. The pure functions above are import-safe.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { readFileSync, writeFileSync, existsSync } = await import("fs");
  const { join } = await import("path");
  const { execSync } = await import("child_process");

  const repoRoot = join(import.meta.dir, "..");
  const rootEnv = join(repoRoot, ".env");
  const rootExample = join(repoRoot, ".env.example");

  // Scope SSOT: the real root .env when present (maintainer), else the committed
  // .env.example (CI / fresh clone) — both carry identical #@scope structure.
  const scopeSourcePath = existsSync(rootEnv) ? rootEnv : rootExample;
  const scopeSource = readFileSync(scopeSourcePath, "utf8");
  const parsed = parseScopedEnv(scopeSource);

  const cmd = process.argv[2];

  if (cmd === "gen") {
    if (parsed.errors.length) {
      console.error("[env-scopes gen] parse errors:\n  " + parsed.errors.join("\n  "));
      process.exit(1);
    }
    writeFileSync(rootExample, renderEnvExample(parsed.vars));
    console.log(`[env-scopes gen] wrote ${rootExample} (${parsed.vars.length} vars, secrets empty)`);
    process.exit(0);
  }

  if (cmd === "check") {
    // Rendered public artifacts to scan: the committed root .env.example + the
    // two binary templates (rendered in-memory = exactly what ships in the zips).
    const artifacts: Record<string, string> = {
      ".env.example": existsSync(rootExample) ? readFileSync(rootExample, "utf8") : "",
      "mcp-rpi/.env.example": renderBinaryTemplate(parsed.vars, "mcp-rpi", "RPI MCP Server"),
      "mcp-drh/.env.example": renderBinaryTemplate(parsed.vars, "mcp-drh", "DRH MCP Server"),
    };

    // Sensitive vault values (only when the real root .env is present).
    const sensitiveValues = existsSync(rootEnv)
      ? sensitiveValuesFrom(readFileSync(rootEnv, "utf8"))
      : undefined;

    // Per-scope code reads (best-effort grep; container keys whitelisted).
    const SCOPE_DIRS: Record<string, string[]> = {
      "hosted-app": ["apps"],
      "mcp-rpi": ["packages/mcp-rpi"],
      "mcp-drh": ["packages/mcp-drh"],
    };
    const codeReads: Partial<Record<Scope, Set<string>>> = {};
    for (const [scope, dirs] of Object.entries(SCOPE_DIRS)) {
      const reads = new Set<string>();
      for (const v of parsed.vars) {
        for (const dir of dirs) {
          try {
            const hit = execSync(
              `grep -rlE "process\\.env\\.${v.key}\\b|env\\.${v.key}\\b" ${dir} --include=*.ts --include=*.tsx 2>/dev/null | grep -vE "node_modules|/dist/|/\\.next/|__tests__|/tests/|copy-dist-templates|\\.test\\." || true`,
              { cwd: repoRoot, encoding: "utf8" },
            ).trim();
            if (hit) { reads.add(v.key); break; }
          } catch { /* grep miss */ }
        }
      }
      codeReads[scope as Scope] = reads;
    }

    const result = runBuildCheck({
      vars: parsed.vars,
      parseErrors: parsed.errors,
      artifacts,
      codeReads,
      sensitiveValues,
    });

    // Guard the bundle compose against config drift (keys hidden only in compose,
    // or superset keys hardcoded here instead of coming from .env via env_file).
    const composePath = join(repoRoot, "packaging", "docker-bundle", "docker-compose.yml");
    if (existsSync(composePath)) {
      const supersetKeys = new Set(parsed.vars.map((v) => v.key));
      const composeErrors = checkComposeEnv(readFileSync(composePath, "utf8"), supersetKeys);
      result.errors.push(...composeErrors);
    }

    for (const w of result.warnings) console.warn(`[env-scopes check] WARN ${w}`);
    if (result.errors.length) {
      console.error("[env-scopes check] FAIL:\n  " + result.errors.join("\n  "));
      process.exit(1);
    }
    console.log(`[env-scopes check] OK — ${parsed.vars.length} vars, all scoped, no secret/host leak, compose env matches superset+overrides`);
    process.exit(0);
  }

  console.error("usage: bun run scripts/env-scopes.ts <gen|check>");
  process.exit(2);
}
