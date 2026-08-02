/**
 * Unit tests for RPI write-tool enforcement (createRPIMcpServer's gate).
 *
 * The standalone RPI binary exposes the raw registered surface to any MCP
 * client, so every write tool (annotations.readOnlyHint === false) must be BOTH
 * absent from tools/list AND rejected on tools/call by name. A list-only filter
 * (tool-filter.ts) would leave them callable — this verifies the SDK `.disable()`
 * path, which blocks both. The two allowlisted job tools (selection-rule
 * count/waterfall, kept as accepted risk) must stay listed and callable.
 *
 * Mirrors packages/mcp-drh/src/__tests__/write-enforcement.test.ts.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { createRPIMcpServer } from "../server.js";
import type { RPIConfig } from "../config.js";
import { RPIAuthService } from "../client/rpi-auth.js";

describe("RPI write-tool enforcement", () => {
  // The 5 genuine writes (annotations.readOnlyHint === false, not allowlisted).
  const GATED = [
    "create_folder",
    "activate_interaction_workflow",
    "run_interaction_workflow",
    "control_workflow_instance",
    "run_audience_test_workflow",
  ].sort();
  // Accepted-risk job tools kept reachable (core rep workflow; start server-side
  // jobs but return counts — NOT cleared, pending an SME verdict).
  const ALLOWED_WRITES = ["run_selection_rule_count", "run_selection_rule_waterfall"];

  let server: ReturnType<typeof createRPIMcpServer>["server"];

  beforeAll(() => {
    const config: RPIConfig = {
      integrationApiUrl: "https://example.com",
      proxyEnabled: false,
      oauthClientId: "test-oauth-client",
      oauthClientSecret: "test-oauth-secret",
      defaultClientId: "test-default-client",
      authRequired: false,
    };
    const authService = new RPIAuthService(
      config.integrationApiUrl,
      config.oauthClientId,
      config.oauthClientSecret,
    );
    ({ server } = createRPIMcpServer(config, authService));
  });

  function callHandler(method: string, params: Record<string, unknown>) {
    const handler = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (req: unknown, extra: unknown) => Promise<unknown>
        >;
      }
    )._requestHandlers.get(method);
    if (!handler) throw new Error(`${method} handler not registered`);
    return handler(
      { method, params },
      { signal: new AbortController().signal, sendRequest: () => Promise.resolve({}) },
    );
  }

  // The SDK's CallTool handler surfaces the disabled McpError as an isError
  // result (createToolError) rather than a thrown exception — its InvalidParams
  // code isn't the one case (UrlElicitationRequired) it re-throws. Either way the
  // handler never runs: the text carries "Tool <name> disabled".
  function resultText(res: unknown): string {
    const r = res as { isError?: boolean; content?: Array<{ text?: string }> };
    return (r.content ?? []).map((c) => c.text ?? "").join(" ");
  }

  it("omits exactly the 5 write tools from tools/list", async () => {
    const result = (await callHandler("tools/list", {})) as {
      tools: Array<{ name: string }>;
    };
    const names = new Set(result.tools.map((t) => t.name));
    for (const g of GATED) expect(names.has(g)).toBe(false);
    // The two accepted-risk job tools remain listed.
    for (const a of ALLOWED_WRITES) expect(names.has(a)).toBe(true);
  });

  it("rejects tools/call on each gated write with the SDK 'disabled' error", async () => {
    for (const name of GATED) {
      const res = (await callHandler("tools/call", { name, arguments: {} })) as {
        isError?: boolean;
      };
      expect(res.isError).toBe(true);
      expect(resultText(res)).toContain("disabled");
    }
  });

  it("keeps the allowlisted count/waterfall job tools callable (never the 'disabled' error)", async () => {
    for (const name of ALLOWED_WRITES) {
      // No live RPI, so the call fails at the network layer and comes back as an
      // isError result — but it must NOT be the gate's "disabled" rejection.
      const res = await callHandler("tools/call", {
        name,
        arguments: { selectionRuleId: "x" },
      });
      expect(resultText(res)).not.toContain("disabled");
    }
  });
});
