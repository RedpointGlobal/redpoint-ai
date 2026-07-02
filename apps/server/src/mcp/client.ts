import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { McpConnection } from "@redpoint-ai/shared";
import type { Tool } from "ai";
import { mcpCalls } from "../routes/metrics.js";
import {
  createPatchedTransport,
  type PatchedTransport,
} from "./patched-transport.js";

/** Allowlisted binaries for MCP stdio — defense-in-depth (also validated at schema level) */
const SAFE_MCP_COMMANDS = new Set([
  "node", "bun", "npx", "bunx", "python", "python3", "uvx", "docker",
]);

/** Env vars that could hijack process loading */
const DANGEROUS_ENV_VARS = new Set([
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
]);

function validateStdioCommand(command: string): void {
  const basename = command.split("/").pop() ?? command;
  if (!SAFE_MCP_COMMANDS.has(basename)) {
    const permitted = [...SAFE_MCP_COMMANDS].toString();
    throw new Error(
      "MCP stdio command \"" + basename + "\" is not in the allowlist. Permitted: " + permitted,
    );
  }
}

function sanitizeEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const cleaned = { ...env };
  for (const key of DANGEROUS_ENV_VARS) {
    delete cleaned[key];
  }
  return cleaned;
}

/**
 * Manages MCP client connections per workspace.
 * Lazily creates and caches connections. Namespaces tools by MCP server name.
 */
export class MCPClientManager {
  // Cache: "workspaceId::serverName" -> MCPClient
  private clients = new Map<string, MCPClient>();
  // Cache: "workspaceId::serverName" -> PatchedTransport (for capability access)
  private transports = new Map<string, PatchedTransport>();
  /**
   * Current RPI client/tenant selection, injected as the `clientId` arg on
   * every MCP tool call so downstream RPI requests carry the right
   * `X-ClientID` header. Seeded from `RPI_DEFAULT_CLIENT_ID` at construction.
   * Setter reserved for a future user-facing client switcher.
   */
  private currentClientId: string | undefined = process.env.RPI_DEFAULT_CLIENT_ID;

  /** Override the current RPI client ID (tenant) for subsequent tool calls. */
  setCurrentClientId(clientId: string | undefined): void {
    this.currentClientId = clientId;
  }

  /** Read the current RPI client ID (tenant) used for tool calls. */
  getCurrentClientId(): string | undefined {
    return this.currentClientId;
  }

  /**
   * Get all AI SDK tools for a workspace's MCP connections.
   *
   * Two code paths share this method:
   *
   *   1. Default (no userRpiToken) — clients are created lazily and CACHED
   *      per (workspaceId, serverName). All workspaces sharing this manager
   *      share a single MCP client per server, which means RPI sees every
   *      tool call as the proxy user (RPI_PROXY_USER). This is the existing
   *      behavior and remains correct for shared/non-interactive contexts.
   *
   *   2. Per-user auth (userRpiToken provided) — for HTTP transports we
   *      build a FRESH ephemeral client + transport with
   *      `Authorization: Bearer <userRpiToken>` baked in, scoped to this
   *      request only (no cache). RPI then sees each chat as the specific
   *      user who logged in via the rpi-native NextAuth provider in
   *      apps/web, applying that user's RBAC instead of the shared proxy.
   *
   * The ephemeral client's lifetime is tied to the lifetime of the returned
   * tools object — once the chat handler returns and the tools go out of
   * scope, GC reclaims the client. We deliberately do NOT track ephemeral
   * clients in any persistent map: that would conflate "for this request"
   * with "for this user", which is wrong if the user pivots clients/tabs.
   *
   * stdio transports always go through the cached path — they don't have an
   * inbound HTTP layer for the Bearer to attach to.
   */
  async getToolsForWorkspace(
    workspaceId: string,
    mcpConnections: McpConnection[],
    userRpiToken?: string,
  ): Promise<Record<string, Tool>> {
    const allTools: Record<string, Tool> = {};

    for (const conn of mcpConnections) {
      const cacheKey = `${workspaceId}::${conn.name}`;
      let client: MCPClient;

      if (userRpiToken && conn.transport === "http" && conn.url) {
        // Ephemeral path — fresh client+transport with the user's Bearer.
        // No cache write; this client lives for the request only.
        client = await this.createClient(conn, undefined, {
          Authorization: `Bearer ${userRpiToken}`,
        });
      } else {
        // Cached path — shared across workspaces with the same connection.
        const cached = this.clients.get(cacheKey);
        if (cached) {
          client = cached;
        } else {
          client = await this.createClient(conn, cacheKey);
          this.clients.set(cacheKey, client);
        }
      }

      // If allowedTools is set, pass it as a `names` filter to tools/list.
      // MCP servers that honor filtering (like packages/mcp-rpi) will trim the
      // response server-side. Legacy servers ignore the extra param; the
      // client-side filter loop below handles those as defense-in-depth.
      const tools = conn.allowedTools && conn.allowedTools.length > 0
        ? await (async () => {
            const defs = await client.listTools({
              params: { names: conn.allowedTools } as unknown as {
                cursor?: string;
              },
            });
            return client.toolsFromDefinitions(defs);
          })()
        : await client.tools();

      // Namespace tools by server name and apply allowedTools filter
      for (const [toolName, tool] of Object.entries(tools)) {
        const namespacedName = `${conn.name}__${toolName}`;

        if (
          conn.allowedTools &&
          conn.allowedTools.length > 0 &&
          !conn.allowedTools.includes(toolName)
        ) {
          continue;
        }

        allTools[namespacedName] = {
          ...tool,
          execute: tool.execute
            ? async (args: any, options: any) => {
                mcpCalls.inc({ server: conn.name, tool: toolName });
                // Inject the current RPI client/tenant selection. Overrides
                // whatever the LLM may have set for `clientId` so the X-ClientID
                // header downstream always reflects the agent's current choice.
                const enrichedArgs =
                  this.currentClientId !== undefined
                    ? { ...args, clientId: this.currentClientId }
                    : args;
                return tool.execute!(enrichedArgs, options);
              }
            : undefined,
        } as typeof tool;
      }
    }

    return allTools;
  }

  /**
   * Get the patched transport for a cached connection (if HTTP).
   * Used by category discovery to read server capabilities.
   */
  getTransport(workspaceId: string, serverName: string): PatchedTransport | undefined {
    return this.transports.get(`${workspaceId}::${serverName}`);
  }

  /**
   * Build a fresh MCP client for an HTTP or stdio connection.
   *
   * @param conn         Connection config from the workspace.
   * @param cacheKey     Optional — when set, the transport is registered in
   *                     `this.transports` so getTransport() can look it up
   *                     for capability discovery. Omit for ephemeral
   *                     per-user clients (we don't want their transport to
   *                     shadow the cached one for capability lookups).
   * @param extraHeaders Optional HTTP headers to bake into the transport.
   *                     Used by the per-user auth path to inject
   *                     `Authorization: Bearer <userRpiToken>`. Headers are
   *                     fixed at transport creation — to rotate the token
   *                     mid-request you'd build a new client.
   */
  private async createClient(
    conn: McpConnection,
    cacheKey?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<MCPClient> {
    if (conn.transport === "http" && conn.url) {
      const transport = createPatchedTransport({
        url: conn.url,
        headers: extraHeaders,
      });
      if (cacheKey) this.transports.set(cacheKey, transport);
      return createMCPClient({
        transport,
        name: `redpoint-ai-${conn.name}`,
      });
    }

    if (conn.transport === "stdio" && conn.command) {
      validateStdioCommand(conn.command);

      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );

      const stdioTransport = new StdioClientTransport({
        command: conn.command,
        args: conn.args,
        env: sanitizeEnv(conn.env as Record<string, string>),
      });

      return createMCPClient({
        transport: stdioTransport as any,
        name: `redpoint-ai-${conn.name}`,
      });
    }

    throw new Error(
      `Invalid MCP connection config for "${conn.name}": HTTP requires url, stdio requires command`,
    );
  }

  /**
   * Close all cached clients for a workspace.
   */
  async closeWorkspace(workspaceId: string): Promise<void> {
    const prefix = `${workspaceId}::`;
    for (const [key, client] of this.clients.entries()) {
      if (key.startsWith(prefix)) {
        await client.close();
        this.clients.delete(key);
        this.transports.delete(key);
      }
    }
  }

  /**
   * Close all clients.
   */
  async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
    this.transports.clear();
  }
}

// Singleton instance
export const mcpManager = new MCPClientManager();
