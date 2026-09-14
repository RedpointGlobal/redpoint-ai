#!/usr/bin/env bun
/**
 * bun run generate:tools — emit committed MCP tool files for the in-scope RPI GET
 * endpoints (#27634 superset-at-build). For each in-scope GET (254 GETs − 66 cut =
 * 188): skip the ones the hand-written 47 already cover (additive); join the rest to
 * the OVERLAY by operationId; a GET with no overlay entry prints a build warning and
 * emits no tool. Emitted tools carry a hand-written description (overlay), a Zod
 * inputSchema from the query/path params (X-ClientID excluded — the client injects
 * it; clientId + verbose kept to match the hand-tool contract), readOnlyHint:true,
 * and an auto _meta.endpoints stamp (normalized by the shared normalizer at mask time).
 *
 * Output = per-category files src/tools/generated/<category>.ts (DO-NOT-EDIT) + a
 * registerGeneratedTools barrel. COMMITTED (reviewable diffs; every build path
 * inherits it; fresh clone needs no spec). `--check` verifies the commit is current.
 *
 * Reads the real env (RPI_OPENAPI_SPEC ?? {RPI_INTEGRATION_API_URL}/swagger/v1/
 * swagger.json), same derivation as generate-types.ts.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EXPECTED_IN_SCOPE, isExcluded, isSuppressedDuplicate } from "../src/tools/exclusions.ts";
import { OVERLAY, type OverlayEntry } from "../src/tools/overlay.ts";
import { normalizeEndpoint } from "../src/endpoint-path.ts";
import type { RPIApiClient } from "../src/client/rpi-api.ts";
import type { RPIAuthService } from "../src/client/rpi-auth.ts";
import { registerAudienceTools } from "../src/tools/audiences.ts";
import { registerAdminTools } from "../src/tools/admin.ts";
import { registerAuthTools } from "../src/tools/auth.ts";
import { registerClientTools } from "../src/tools/clients.ts";
import { registerFileSystemTools } from "../src/tools/file-system.ts";
import { registerFolderTools } from "../src/tools/folders.ts";
import { registerInteractionTools } from "../src/tools/interactions.ts";
import { registerSelectionRuleTools } from "../src/tools/selection-rules.ts";

// Guard 1 (derived, not a hand-list): register the actual hand-written 47 on a
// throwaway server (registration wires handlers, never calls the API) and read
// their _meta.endpoints. This is the single source of truth for "already covered"
// — a hand-tool edit or path rename updates it automatically at the next regen, so
// the additive skip-set can't silently drift.
function deriveHandEndpoints(): Set<string> {
  const s = new McpServer({ name: "hand-probe", version: "0" });
  const fake = {} as RPIApiClient;
  registerAudienceTools(s, fake);
  registerAdminTools(s, fake);
  registerAuthTools(s, fake, {} as RPIAuthService, null);
  registerClientTools(s, fake);
  registerFileSystemTools(s, fake);
  registerFolderTools(s, fake);
  registerInteractionTools(s, fake);
  registerSelectionRuleTools(s, fake);
  const reg = (s as unknown as {
    _registeredTools: Record<string, { _meta?: { endpoints?: string[] } }>;
  })._registeredTools;
  const set = new Set<string>();
  for (const t of Object.values(reg)) {
    for (const e of t._meta?.endpoints ?? []) set.add(normalizeEndpoint(e));
  }
  return set;
}
const HAND_COVERED_ENDPOINTS = deriveHandEndpoints();

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "../src/tools/generated");
const isCheck = process.argv.includes("--check");

// --- load root .env (workspace-filtered cwd doesn't inherit it) ---
const rootEnv = resolve(__dirname, "../../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (!v.startsWith('"') && !v.startsWith("'")) {
      const c = v.indexOf("#");
      if (c > 0) v = v.slice(0, c).trim();
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

// --- resolve + load the spec ---
const explicitSpec = process.env.RPI_OPENAPI_SPEC?.trim();
const baseUrl = process.env.RPI_INTEGRATION_API_URL?.trim().replace(/\/+$/, "");
const specSource = explicitSpec || (baseUrl ? `${baseUrl}/swagger/v1/swagger.json` : undefined);
if (!specSource) {
  console.error("ERROR: no spec source (set RPI_OPENAPI_SPEC or RPI_INTEGRATION_API_URL).");
  process.exit(1);
}
const isUrl = specSource.startsWith("http://") || specSource.startsWith("https://");
console.error(`[generate-tools] spec: ${isUrl ? "(configured instance)" : specSource}`);
let specText: string;
if (isUrl) {
  const res = await fetch(specSource, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) { console.error(`ERROR: spec fetch ${res.status}`); process.exit(1); }
  specText = await res.text();
} else {
  if (!existsSync(specSource)) { console.error(`ERROR: spec file not found: ${specSource}`); process.exit(1); }
  specText = readFileSync(specSource, "utf8");
}
const spec = JSON.parse(specText) as {
  paths: Record<string, Record<string, {
    operationId?: string;
    parameters?: { name: string; in: string; required?: boolean }[];
  }>>;
};

// --- enumerate in-scope GETs; assert the count tripwire ---
interface GetOp { path: string; postV2: string; operationId: string; query: string[]; pathParams: string[]; }
const inScope: GetOp[] = [];
for (const [p, node] of Object.entries(spec.paths)) {
  const op = node.get;
  if (!op) continue;
  const operationId = op.operationId ?? "";
  if (isExcluded(p, operationId)) continue;
  const params = op.parameters ?? [];
  inScope.push({
    path: p,
    postV2: p.replace(/^\/api\/v2(?=\/|$)/, ""),
    operationId,
    query: params.filter((x) => x.in === "query").map((x) => x.name),
    pathParams: params.filter((x) => x.in === "path").map((x) => x.name),
  });
}
if (inScope.length !== EXPECTED_IN_SCOPE) {
  console.error(
    `ERROR: in-scope GET count is ${inScope.length}, expected ${EXPECTED_IN_SCOPE}. ` +
      `A spec revision changed the surface — review the exclusion config and update EXPECTED_IN_SCOPE deliberately.`,
  );
  process.exit(1);
}

// --- Guard 3 (cuz sweep #27634): fail the build if any in-scope GET's operationId
// carries a mutation verb, unless it is explicitly excluded (handled above, so it
// never reaches here) or allow-listed as a verified read. Catches a future spec
// revision that adds an action-shaped GET before anyone re-runs the manual sweep. ---
const MUTATION_VERBS = new Set([
  "stop", "start", "activate", "deactivate", "run", "execute", "trigger",
  "cancel", "reset", "clear", "refresh", "rebuild", "send", "apply", "sync",
  "enable", "disable", "publish", "approve",
]);
// operationIds whose verb-hit is a NOUN/modifier, not an action — verified reads
// (cuz sweep 2026-08-06). Each is a genuine GET that changes no state.
const VERIFIED_READ = new Set([
  "GetWebPublishSite",                                  // "web-publish-site-map" is a noun
  "GetWebPublishSiteMapByName",
  "GetWebPublishSiteMaps",
  "GetListSyncInfo",                                    // reads connector sync STATUS
  "GetInteractionTrigger",                              // "trigger" config, read
  "CalculateInteractionTriggerRecurrenceNextFiringTimes", // pure computation
]);
const camelWords = (oid: string): string[] =>
  (oid.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z]+|[A-Z]+|[a-z]+|[0-9]+/g) ?? []).map((w) =>
    w.toLowerCase(),
  );
const actionViolations = inScope.filter(
  (op) =>
    !VERIFIED_READ.has(op.operationId) &&
    camelWords(op.operationId).some((w) => MUTATION_VERBS.has(w)),
);
if (actionViolations.length > 0) {
  console.error(
    `ERROR: ${actionViolations.length} in-scope GET(s) carry a mutation verb but are neither excluded nor allow-listed as verified reads:`,
  );
  for (const op of actionViolations) {
    console.error(`    - ${op.operationId} (${op.postV2})`);
  }
  console.error(
    `Re-run the mutation-verb sweep: EXCLUDE it (exclusions.ts action-shaped bucket) if it mutates, or add it to VERIFIED_READ if the verb is a noun/read.`,
  );
  process.exit(1);
}

// --- join overlay; bucket by category; warn on missing ---
const byCategory = new Map<string, { op: GetOp; entry: OverlayEntry }[]>();
const missing: string[] = [];
let skippedCovered = 0;
let suppressed = 0;
for (const op of inScope) {
  if (HAND_COVERED_ENDPOINTS.has(normalizeEndpoint(op.postV2))) { skippedCovered++; continue; }
  // Functional duplicates: in-scope but a hand tool covers the purpose via a
  // different endpoint — counted separately (not emitted, not "awaiting").
  if (isSuppressedDuplicate(op.operationId)) { suppressed++; continue; }
  const entry = OVERLAY[op.operationId];
  if (!entry) { missing.push(`${op.operationId} (${op.postV2})`); continue; }
  const arr = byCategory.get(entry.category) ?? [];
  arr.push({ op, entry });
  byCategory.set(entry.category, arr);
}

// Guard 2 (structural backstop): no emitted tool may share a hand-tool endpoint,
// so a duplicate is impossible regardless of the derived skip-set being perfect.
for (const arr of byCategory.values()) {
  for (const { op, entry } of arr) {
    if (HAND_COVERED_ENDPOINTS.has(normalizeEndpoint(op.postV2))) {
      console.error(
        `ERROR: generated tool "${entry.toolName}" (${op.postV2}) collides with a hand-written tool's endpoint.`,
      );
      process.exit(1);
    }
  }
}

// --- emit ---
const HEADER =
  "// AUTO-GENERATED by scripts/generate-tools.ts — DO NOT EDIT.\n" +
  "// In-scope RPI GET endpoints (#27634). Regenerate: bun run generate:tools\n" +
  "// All tools are read-only (GET); descriptions come from src/tools/overlay.ts.\n";
const HEADER_LINES = 3;

function title(toolName: string): string {
  return toolName.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function argName(param: string): string {
  // valid JS identifier for the destructured arg (spec params are already identifier-safe)
  return param;
}
function emitTool(op: GetOp, entry: OverlayEntry): string {
  const allParams = [...op.query, ...op.pathParams];
  const schemaLines = allParams
    .map((p) => `      ${JSON.stringify(argName(p))}: z.string().optional().describe(${JSON.stringify(`${p} (${op.query.includes(p) ? "query" : "path"} parameter)`)}),`)
    .join("\n");
  const destructure = [...allParams.map(argName), "clientId", "verbose"].join(", ");
  const pathSubs = op.pathParams
    .map((p) => `      path = path.replace(${JSON.stringify(`{${p}}`)}, encodeURIComponent(String(${argName(p)} ?? "")));`)
    .join("\n");
  const querySubs = op.query
    .map((p) => `      if (${argName(p)} !== undefined) query[${JSON.stringify(p)}] = String(${argName(p)});`)
    .join("\n");
  return `  registerTool(
    ${JSON.stringify(entry.toolName)},
    {
      _meta: { endpoints: [${JSON.stringify(op.postV2)}] },
      title: ${JSON.stringify(title(entry.toolName))},
      description: ${JSON.stringify(entry.description)},
      inputSchema: {
${schemaLines ? schemaLines + "\n" : ""}      clientId: clientIdSchema,
      verbose: verboseSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ ${destructure} }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        let path = ${JSON.stringify(op.postV2)};
${pathSubs ? pathSubs + "\n" : ""}        const query: Record<string, string> = {};
${querySubs ? querySubs + "\n" : ""}        const result = await rpiClient.get(userToken, path, query, { clientId, verbose, baseUrl: targetUrlOf(extra) });
        return jsonContent(result);
      } catch (error) {
        return errorContent(${JSON.stringify(`Error in ${entry.toolName}`)}, error);
      }
    },
  );`;
}
function emitCategoryFile(category: string, tools: { op: GetOp; entry: OverlayEntry }[]): string {
  const needsZod = tools.some((t) => t.op.query.length + t.op.pathParams.length > 0);
  const fn = `register${title(category.replace(/-/g, "_")).replace(/ /g, "")}GeneratedTools`;
  return (
    HEADER +
    "\n" +
    (needsZod ? 'import { z } from "zod";\n' : "") +
    'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n' +
    'import type { RPIApiClient } from "../../client/rpi-api.js";\n' +
    'import { createToolRegistrar } from "../../tool-categories.js";\n' +
    'import { clientIdSchema, verboseSchema, jsonContent, errorContent, READ_ONLY_ANNOTATIONS, targetUrlOf } from "../generated-shared.js";\n' +
    "\n" +
    `export function ${fn}(server: McpServer, rpiClient: RPIApiClient): void {\n` +
    `  const registerTool = createToolRegistrar(server, ${JSON.stringify(category)});\n` +
    `  void rpiClient;\n` +
    tools.map((t) => emitTool(t.op, t.entry)).join("\n") +
    "\n}\n"
  );
}
function categoryFn(category: string): string {
  return `register${title(category.replace(/-/g, "_")).replace(/ /g, "")}GeneratedTools`;
}
function emitBarrel(categories: string[]): string {
  return (
    HEADER +
    "\n" +
    'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n' +
    'import type { RPIApiClient } from "../../client/rpi-api.js";\n' +
    categories.map((c) => `import { ${categoryFn(c)} } from ${JSON.stringify(`./${c}.js`)};\n`).join("") +
    "\n" +
    "/** Register all generated (spec-derived) read-only tools. */\n" +
    "export function registerGeneratedTools(server: McpServer, rpiClient: RPIApiClient): void {\n" +
    categories.map((c) => `  ${categoryFn(c)}(server, rpiClient);\n`).join("") +
    "}\n"
  );
}

const categories = [...byCategory.keys()].sort();
const files = new Map<string, string>();
for (const c of categories) files.set(`${c}.ts`, emitCategoryFile(c, byCategory.get(c)!));
files.set("index.ts", emitBarrel(categories));

const stripHeader = (s: string) => s.split("\n").slice(HEADER_LINES).join("\n");

if (isCheck) {
  let drift = false;
  for (const [name, content] of files) {
    const path = join(outDir, name);
    if (!existsSync(path) || stripHeader(readFileSync(path, "utf8")) !== stripHeader(content)) {
      console.error(`ERROR: ${name} is out of date — run 'bun run generate:tools'.`);
      drift = true;
    }
  }
  // also flag committed files that should no longer exist
  console.error(`[generate-tools] check: ${inScope.length} in-scope, ${skippedCovered} hand-covered, ${suppressed} suppressed, ${missing.length} missing overlay`);
  process.exit(drift ? 1 : 0);
}

// The generated dir holds ONLY generated files (the shared helper lives at
// ../generated-shared.ts), so a clean rebuild is safe.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const [name, content] of files) writeFileSync(join(outDir, name), content);

const emittedCount = [...byCategory.values()].reduce((n, a) => n + a.length, 0);
console.error(
  `[generate-tools] emitted ${categories.length} categor(ies), ` +
    `${emittedCount} tool(s); ` +
    `${skippedCovered} hand-covered skipped; ${suppressed} suppressed (functional dup); ` +
    `${missing.length} in-scope GET(s) awaiting overlay.`,
);
// Finish arithmetic (always holds by construction; surfaced so the accounting is explicit):
console.error(
  `[generate-tools] accounting: ${inScope.length} in-scope = ${emittedCount} authored + ` +
    `${skippedCovered} hand-covered + ${suppressed} suppressed + ${missing.length} awaiting.`,
);
if (missing.length) {
  console.error(`[generate-tools] WARNING — ${missing.length} in-scope GET(s) have no overlay entry (no tool emitted):`);
  for (const m of missing.slice(0, 10)) console.error(`    - ${m}`);
  if (missing.length > 10) console.error(`    … and ${missing.length - 10} more`);
}
console.error("[generate-tools] Done.");
