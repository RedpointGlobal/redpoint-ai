/**
 * patched-transport.ts — unit tests.
 *
 * The patched transport is a plain HTTP POST adapter for MCP servers that
 * don't fully comply with the MCP spec. It patches protocolVersion and
 * serverInfo on initialize responses, synthesizes JSON-RPC errors for HTTP
 * failures, and captures server capabilities for category discovery.
 *
 * Tests stub global fetch and call transport.send() directly, asserting
 * on onmessage and onerror callbacks. No real HTTP, no MCP server.
 *
 * Ported from RP-Vercel-Agent v3 (tests/src/patched-transport.test.ts).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { createPatchedTransport } from "../mcp/patched-transport.js";

const BASE_CONFIG = { url: "http://fake-mcp.local/rpc" };

// Save and restore original fetch
const originalFetch = globalThis.fetch;

function stubFetch(fn: typeof fetch) {
  globalThis.fetch = fn;
}

describe("createPatchedTransport", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a POST request and calls onmessage with the parsed response", async () => {
    const responseBody = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    stubFetch(async () => new Response(JSON.stringify(responseBody), { status: 200 }));

    const transport = createPatchedTransport(BASE_CONFIG);
    const messages: unknown[] = [];
    transport.onmessage = (msg: unknown) => messages.push(msg);

    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).result.tools).toEqual([]);
  });

  it("patches protocolVersion 1.0.0 to 2024-11-05 on initialize responses", async () => {
    const initResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "1.0.0", capabilities: {} },
    };
    stubFetch(async () => new Response(JSON.stringify(initResponse), { status: 200 }));

    const transport = createPatchedTransport(BASE_CONFIG);
    const messages: unknown[] = [];
    transport.onmessage = (msg: unknown) => messages.push(msg);

    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect((messages[0] as any).result.protocolVersion).toBe("2024-11-05");
  });

  it("injects serverInfo when missing from initialize responses", async () => {
    const initResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "1.0.0", capabilities: {} },
    };
    stubFetch(async () => new Response(JSON.stringify(initResponse), { status: 200 }));

    const transport = createPatchedTransport(BASE_CONFIG);
    const messages: unknown[] = [];
    transport.onmessage = (msg: unknown) => messages.push(msg);

    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect((messages[0] as any).result.serverInfo).toEqual({
      name: "mcp-server",
      version: "1.0.0",
    });
  });

  it("does not patch non-initialize responses", async () => {
    const toolsResponse = {
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "list_audiences" }] },
    };
    stubFetch(async () => new Response(JSON.stringify(toolsResponse), { status: 200 }));

    const transport = createPatchedTransport(BASE_CONFIG);
    const messages: unknown[] = [];
    transport.onmessage = (msg: unknown) => messages.push(msg);

    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const received = messages[0] as any;
    expect(received.result.protocolVersion).toBeUndefined();
    expect(received.result.serverInfo).toBeUndefined();
    expect(received.result.tools).toEqual([{ name: "list_audiences" }]);
  });

  it("synthesizes a JSON-RPC error response on HTTP error when request has an id (status only, no body leak)", async () => {
    // SECURITY: the raw upstream body must never reach the JSON-RPC error the
    // agent surfaces — status + statusText only. (See the leak guard test.)
    stubFetch(
      async () =>
        new Response("SECRET_BODY_LEAK internal-url=https://internal.host", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );

    const transport = createPatchedTransport(BASE_CONFIG);
    const messages: unknown[] = [];
    transport.onmessage = (msg: unknown) => messages.push(msg);

    await transport.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });

    expect(messages).toHaveLength(1);
    const received = messages[0] as any;
    expect(received.id).toBe(5);
    expect(received.error.code).toBe(-32000);
    expect(received.error.message).toContain("401");
    expect(received.error.message).toContain("Unauthorized"); // statusText, safe
    expect(received.error.message).not.toContain("SECRET_BODY_LEAK");
    expect(received.error.message).not.toContain("internal.host");
  });

  it("calls onerror on HTTP error when request has no id", async () => {
    stubFetch(async () => new Response("", { status: 500, statusText: "Internal Server Error" }));

    const transport = createPatchedTransport(BASE_CONFIG);
    const errors: Error[] = [];
    transport.onerror = (err: Error) => errors.push(err);

    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("500");
  });

  it("calls onerror when fetch throws a network error", async () => {
    stubFetch(async () => { throw new Error("ECONNREFUSED"); });

    const transport = createPatchedTransport(BASE_CONFIG);
    const errors: Error[] = [];
    transport.onerror = (err: Error) => errors.push(err);

    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("ECONNREFUSED");
  });

  it("returns silently when response body is not valid JSON", async () => {
    stubFetch(async () => new Response("", { status: 200 }));

    const transport = createPatchedTransport(BASE_CONFIG);
    const messages: unknown[] = [];
    const errors: Error[] = [];
    transport.onmessage = (msg: unknown) => messages.push(msg);
    transport.onerror = (err: Error) => errors.push(err);

    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
