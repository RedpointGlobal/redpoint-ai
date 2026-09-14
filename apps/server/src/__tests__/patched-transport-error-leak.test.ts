/**
 * SECURITY guard — the patched MCP transport must NOT put the raw upstream
 * error body into the JSON-RPC error it hands the agent. On a non-OK HTTP
 * response it carries status + statusText only. TRIPS on reintroduction:
 * re-add `errorDetail = await response.text()` at the error branch and the
 * body assertion below goes red.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { createPatchedTransport } from "../mcp/patched-transport.js";

const SECRET_BODY =
  "SECRET_LEAK_MARKER internal-url=https://internal.host/admin <html>stack trace</html> token=abc123";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("patched-transport error leak guard", () => {
  it("non-OK response → JSON-RPC error carries status+statusText, NOT the raw body", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(SECRET_BODY, { status: 500, statusText: "Internal Server Error" }),
    ) as unknown as typeof fetch;

    const transport = createPatchedTransport({ url: "https://mcp.example.test/mcp" });

    let captured: { error?: { message?: string } } | undefined;
    transport.onmessage = (m: unknown) => {
      captured = m as { error?: { message?: string } };
    };

    // A request WITH an id takes the error-response branch (the one that used
    // to leak the body).
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    const msg = captured?.error?.message ?? "";
    expect(msg).toContain("500");
    expect(msg).toContain("Internal Server Error");
    expect(msg).not.toContain("SECRET_LEAK_MARKER");
    expect(msg).not.toContain("internal.host");
    expect(msg).not.toContain("token=abc123");
  });
});
