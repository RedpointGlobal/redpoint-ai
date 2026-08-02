/**
 * Unit tests for DRH write-tool enforcement (createDrhMcpServer's gate).
 *
 * The standalone DRH binary exposes the raw registered surface to any MCP
 * client, so every MUTATING/DESTRUCTIVE tool must be BOTH absent from tools/list
 * AND rejected on tools/call by name. A list-only filter would leave them
 * callable — this verifies the SDK `.disable()` path, which blocks both.
 *
 * No network: registration and tools/list never call DRH, so a credential-less
 * client is fine.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { createDrhMcpServer } from "../server.js";
import { DRHApiClient } from "../client/drh-api.js";
import { DRHAuthService } from "../client/drh-auth.js";

// Representative gated tools spanning MUTATING (create/update/control) and
// DESTRUCTIVE (delete) presets across several domains.
const GATED_SAMPLE = [
  "drh_create_database",
  "drh_delete_database",
  "drh_create_feed",
  "drh_delete_feed",
  "drh_create_match_run",
  "drh_create_rpi_sync_run",
  "drh_delete_schedule",
  "drh_delete_source",
  "drh_delete_subject_area",
  "drh_delete_data_quality",
];

describe("DRH write-tool enforcement", () => {
  let server: ReturnType<typeof createDrhMcpServer>["server"];

  beforeAll(() => {
    const auth = new DRHAuthService("https://example.com");
    const client = new DRHApiClient("https://example.com", auth, "test-client");
    ({ server } = createDrhMcpServer(client));
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

  function resultText(res: unknown): string {
    const r = res as { content?: Array<{ text?: string }> };
    return (r.content ?? []).map((c) => c.text ?? "").join(" ");
  }

  it("exposes only READ_ONLY tools in tools/list (all 36 writes gated)", async () => {
    const result = (await callHandler("tools/list", {})) as {
      tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    };
    // Every listed tool is read-only.
    for (const t of result.tools) {
      expect(t.annotations?.readOnlyHint).not.toBe(false);
    }
    // None of the sampled writes appear.
    const names = new Set(result.tools.map((t) => t.name));
    for (const g of GATED_SAMPLE) expect(names.has(g)).toBe(false);
    // Read-only tools are still present.
    expect(names.size).toBeGreaterThan(0);
  });

  it("rejects tools/call on each gated write with the SDK 'disabled' error", async () => {
    for (const name of GATED_SAMPLE) {
      const res = (await callHandler("tools/call", { name, arguments: {} })) as {
        isError?: boolean;
      };
      expect(res.isError).toBe(true);
      expect(resultText(res)).toContain("disabled");
    }
  });
});
