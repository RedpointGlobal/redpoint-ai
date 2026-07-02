/**
 * MCP transport with server compatibility patches + Streamable HTTP support.
 *
 * Handles two server flavors:
 *   1. Legacy/non-spec-compliant servers — patches:
 *      - protocolVersion "1.0.0" → "2024-11-05" (SDK requires date-based)
 *      - Injects serverInfo when missing (required by MCP spec)
 *   2. Modern Streamable HTTP servers (MCP 2024-11-05+):
 *      - Sends Accept: application/json, text/event-stream per spec
 *        (spec-compliant servers return 406 Not Acceptable without it)
 *      - Captures mcp-session-id from the initialize response and echoes
 *        it on every subsequent request (session continuity); without
 *        this, singleton-McpServer implementations 500 with
 *        "Already connected to a transport" on the second request
 *      - Parses responses with content-type: text/event-stream (SSE)
 *        in addition to plain application/json (without the SSE parser
 *        the SDK hangs silently on Streamable HTTP responses)
 *
 * Also captures serverCapabilities from the initialize response for
 * category-based tool discovery (see mcp-category-discovery.ts).
 *
 * Ported from RP-Vercel-Agent v3 (src/patched-transport.ts).
 */

import type { MCPTransport } from "@ai-sdk/mcp";

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolCategory {
  name: string;
  description?: string;
  estimatedToolCount?: number;
}

export interface FilterParameter {
  name: string;
  type: string;
  description?: string;
  examples?: string[];
}

export interface ListToolsCapability {
  description?: string;
  supportsFiltering: boolean;
  filterParameter?: FilterParameter;
  availableCategories?: ToolCategory[];
}

export interface PatchedTransport extends MCPTransport {
  serverCapabilities: Record<string, unknown> | null;
  /** Session ID echoed back on subsequent requests per MCP Streamable HTTP spec. */
  sessionId: string | null;
}

// TIMEOUT INVARIANT (do not break): this client abort must sit BETWEEN the
// tool poll budget and the mcp-rpi Bun.serve idleTimeout —
//   tool DEFAULT_TIMEOUT_SECONDS 220s  <  this 240s  <  Bun idleTimeout 255s.
// Was 30_000 (30s): long-poll tools (selection-rule count/waterfall poll RPI
// up to the tool budget) were aborted here at 30s, the next cliff after the
// Bun.serve 10s idle-kill. Raising past 240s without also raising Bun's
// idleTimeout (hard-capped 255s) would just relocate the failure.
const DEFAULT_TIMEOUT_MS = 240_000;

export function createPatchedTransport(config: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): PatchedTransport {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const transport: PatchedTransport = {
    serverCapabilities: null,
    sessionId: null,

    async start() {},

    async send(message: unknown) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // MCP Streamable HTTP spec (2024-11-05+) requires the client to
            // advertise BOTH content types in the Accept header. Spec-compliant
            // servers (e.g. @modelcontextprotocol/sdk) return 406 Not Acceptable
            // without this. Older servers ignore the header, so it's safe to
            // always send.
            "Accept": "application/json, text/event-stream",
            // MCP Streamable HTTP session continuity: after the initialize
            // response, the server returns an mcp-session-id header. Echo it
            // on every subsequent request so the server recognizes us as the
            // same client. Without this, each request looks like a new session
            // — which some server implementations can't handle because their
            // singleton McpServer instance is already connected to a transport.
            ...(transport.sessionId
              ? { "mcp-session-id": transport.sessionId }
              : {}),
            ...config.headers,
          },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === "AbortError") {
          this.onerror?.(
            new Error(`MCP request timed out after ${timeoutMs / 1000}s`),
          );
        } else {
          this.onerror?.(
            new Error(
              `MCP network error: ${error instanceof Error ? error.message : error}`,
            ),
          );
        }
        return;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const requestId = (message as Record<string, unknown>)?.id;
        if (requestId != null) {
          let errorDetail = `HTTP ${response.status}`;
          try {
            errorDetail = await response.text();
          } catch {
            /* ignore */
          }
          const errorResponse = {
            jsonrpc: "2.0" as const,
            id: requestId as string | number,
            error: { code: -32000, message: `Server error: ${errorDetail}` },
          };
          this.onmessage?.(
            errorResponse as Parameters<
              NonNullable<MCPTransport["onmessage"]>
            >[0],
          );
          return;
        }
        this.onerror?.(
          new Error(
            `MCP server returned ${response.status}: ${response.statusText}`,
          ),
        );
        return;
      }

      // Capture session ID from the response headers. Spec-compliant MCP
      // Streamable HTTP servers return mcp-session-id on the initialize
      // response; subsequent requests must echo it back (handled in the
      // fetch headers above).
      const returnedSessionId = response.headers.get("mcp-session-id");
      if (returnedSessionId && !transport.sessionId) {
        transport.sessionId = returnedSessionId;
      }

      // MCP Streamable HTTP spec allows the server to respond with either
      // application/json (plain JSON-RPC body) or text/event-stream (SSE
      // stream of messages). Handle both.
      const contentType = response.headers.get("content-type") ?? "";
      let body: JsonRpcResponse;

      if (contentType.includes("text/event-stream")) {
        // Parse SSE: each event is separated by a blank line; payloads live
        // on data: lines. For most MCP request/response patterns there's a
        // single event with a single data line. If multiple data lines exist
        // in one event, they're concatenated with newlines per the SSE spec.
        let rawText: string;
        try {
          rawText = await response.text();
        } catch {
          return;
        }

        const dataLines: string[] = [];
        for (const line of rawText.split(/\r?\n/)) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          } else if (line === "" && dataLines.length > 0) {
            // End of event — take the first complete one for a single-response flow
            break;
          }
        }

        if (dataLines.length === 0) {
          // No data events (e.g. server just sent a heartbeat / comment).
          return;
        }

        try {
          body = JSON.parse(dataLines.join("\n"));
        } catch {
          return;
        }
      } else {
        // Plain JSON response (or empty body for a notification ack).
        try {
          body = await response.json();
        } catch {
          return;
        }
      }

      // Bun's response.json() returns null for empty 202 notification acks
      // (Node throws, which we catch above). Treat null/non-object bodies as
      // no-op acks — no JSON-RPC message to forward.
      if (!body || typeof body !== "object") {
        return;
      }

      // Patch initialize response for server compatibility:
      // 1. Server returns protocolVersion "1.0.0" but SDK requires "2024-11-05" or later
      // 2. Server omits serverInfo (required by MCP spec)
      // 3. Capture server capabilities for category discovery
      if (body.result && "protocolVersion" in body.result) {
        if (body.result.protocolVersion === "1.0.0") {
          body.result.protocolVersion = "2024-11-05";
        }
        if (!("serverInfo" in body.result)) {
          body.result.serverInfo = { name: "mcp-server", version: "1.0.0" };
        }
        if (body.result.capabilities) {
          this.serverCapabilities = body.result.capabilities as Record<
            string,
            unknown
          >;
        }
      }

      this.onmessage?.(
        body as Parameters<NonNullable<MCPTransport["onmessage"]>>[0],
      );
    },

    async close() {
      // Clear session ID so reconnects initialize a fresh session
      // instead of reusing a stale one.
      transport.sessionId = null;
    },

    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  };

  return transport;
}
