/**
 * Integration test: selection-rule RUN tools through the SERVER TOOL PATH.
 *
 * This is the meta-fix. The selection-rule count/waterfall 404 bug shipped
 * TWICE because every prior integration test drove RPIApiClient *directly* —
 * none exercised run_selection_rule_count / run_selection_rule_waterfall
 * through the registered MCP tool handler (registerSelectionRuleTools →
 * tools/call → runSelectionRuleJob → live RPI). A wrong results endpoint
 * is invisible to a client-direct test but 404s here, exactly as a real
 * caller hits it.
 *
 * Skips entirely when env vars are missing. Skips a flow gracefully when
 * the live tenant has no rule of the required shape.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import { registerSelectionRuleTools } from "../../tools/selection-rules.js";

// Root .env loader (mirrors the other integration tests).
const __testsDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(__testsDir, "../../../../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf("#");
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const REQUIRED = [
  "RPI_INTEGRATION_API_URL",
  "RPI_OAUTH_CLIENT_ID",
  "RPI_OAUTH_CLIENT_SECRET",
  "RPI_DEFAULT_CLIENT_ID",
  "RPI_PROXY_USER",
  "RPI_PROXY_PASS",
] as const;
const missing = REQUIRED.filter((k) => !process.env[k]);
const shouldSkip = missing.length > 0;
if (shouldSkip) {
  console.error(
    `[integration] Skipping selection-rule RUN tools — missing env: ${missing.join(", ")}`,
  );
}

function invokeTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<
        string,
        (req: unknown, extra: unknown) => Promise<unknown>
      >;
    }
  )._requestHandlers;
  const handler = handlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler not registered");
  // No authInfo.token → runSelectionRuleJob passes undefined userToken →
  // RPIApiClient uses the proxy-user fallback (same as the other live tests).
  return handler(
    { method: "tools/call", params: { name, arguments: args } },
    { signal: new AbortController().signal, sendRequest: () => Promise.resolve({}) },
  ) as any;
}

describe.skipIf(shouldSkip)("Selection-rule RUN tools (live, server path)", () => {
  let server: McpServer;

  beforeAll(() => {
    const auth = new RPIAuthService(
      process.env.RPI_INTEGRATION_API_URL!,
      process.env.RPI_OAUTH_CLIENT_ID!,
      process.env.RPI_OAUTH_CLIENT_SECRET!,
      process.env.RPI_PROXY_USER,
      process.env.RPI_PROXY_PASS,
    );
    const api = new RPIApiClient(
      process.env.RPI_INTEGRATION_API_URL!,
      auth,
      process.env.RPI_DEFAULT_CLIENT_ID!,
    );
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerSelectionRuleTools(server, api);
  });

  async function firstStandardRuleId(): Promise<string | undefined> {
    const r = await invokeTool(server, "list_selection_rules", {
      subType: "Standard",
    });
    try {
      const p = JSON.parse(r.content[0].text);
      const arr = p.results ?? p.items ?? [];
      return arr[0]?.id;
    } catch {
      return undefined;
    }
  }

  it(
    "run_selection_rule_count returns a count via the tool path (no 404)",
    { timeout: 120_000 },
    async () => {
      const ruleId = await firstStandardRuleId();
      if (!ruleId) {
        console.error("[integration] No Standard rule — skipping count flow.");
        return;
      }
      const res = await invokeTool(server, "run_selection_rule_count", {
        selectionRuleId: ruleId,
        timeoutSeconds: 90,
      });
      const text = res.content[0].text;
      // The exact regression: wrong results endpoint → 404
      // API-ClientJobResultsNotFound. Match the real error ENVELOPE only —
      // never a bare /404/, GUIDs in success payloads contain "404".
      expect(res.isError ?? false).toBe(false);
      expect(text).not.toContain("ClientJobResultsNotFound");
      expect(text).not.toMatch(/RPI API error: 404/);
      const parsed = JSON.parse(text);
      expect(parsed.status.status).toBe("Completed");
      console.error(
        `[integration] count ok: jobId=${parsed.jobId} rule=${ruleId}`,
      );
    },
  );

  it(
    "run_selection_rule_waterfall returns the breakdown via the tool path (no 404)",
    { timeout: 120_000 },
    async () => {
      const ruleId = await firstStandardRuleId();
      if (!ruleId) {
        console.error("[integration] No Standard rule — skipping waterfall.");
        return;
      }
      const res = await invokeTool(server, "run_selection_rule_waterfall", {
        selectionRuleId: ruleId,
        timeoutSeconds: 90,
      });
      const text = res.content[0].text;
      // Envelope-only (see count test): never a bare /404/.
      expect(res.isError ?? false).toBe(false);
      expect(text).not.toContain("ClientJobResultsNotFound");
      expect(text).not.toMatch(/RPI API error: 404/);
      const parsed = JSON.parse(text);
      expect(parsed.status.status).toBe("Completed");
      expect(parsed.results.criterionCounts.length).toBeGreaterThan(0);
      console.error(
        `[integration] waterfall ok: jobId=${parsed.jobId} rule=${ruleId}`,
      );
    },
  );
});
