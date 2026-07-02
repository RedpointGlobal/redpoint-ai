/**
 * mcp-category-discovery.ts — unit tests.
 *
 * Tests the category-based tool discovery feature ported from the C# agent.
 * When an MCP server advertises category filtering in its capabilities, the
 * module synthesizes a `tools_list` meta-tool instead of loading all tools.
 *
 * Uses fake PatchedTransport objects with pre-set serverCapabilities and a
 * minimal mock MCPClient. No real MCP server, no real network.
 *
 * Ported from RP-Vercel-Agent v3 (tests/src/mcp-category-discovery.test.ts).
 */

import { describe, it, expect, mock } from "bun:test";
import {
  extractListToolsCapability,
  buildCategoryTools,
} from "../mcp/mcp-category-discovery.js";
import type {
  PatchedTransport,
  ListToolsCapability,
} from "../mcp/patched-transport.js";

function fakeTransport(
  caps: Record<string, unknown> | null,
): PatchedTransport {
  return {
    serverCapabilities: caps,
    async start() {},
    async send() {},
    async close() {},
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  } as PatchedTransport;
}

function fakeMcpClient(flatTools: Record<string, unknown> = {}) {
  return {
    tools: mock(async () => flatTools),
    listTools: mock(async () => ({
      tools: [
        {
          name: "list_workflows",
          description: "List campaign workflows",
          inputSchema: { type: "object" },
        },
        {
          name: "execute_workflow",
          description: "Execute a campaign workflow",
          inputSchema: { type: "object" },
        },
      ],
    })),
    toolsFromDefinitions: mock(
      (defs: { tools: Array<{ name: string }> }) => {
        const result: Record<string, unknown> = {};
        for (const t of defs.tools) {
          result[t.name] = { description: t.name, execute: mock(() => {}) };
        }
        return result;
      },
    ),
  };
}

const FILTERING_CAPS = {
  tools: {
    listTools: {
      supportsFiltering: true,
      filterParameter: {
        name: "category",
        type: "string",
        description: "Category name",
        examples: ["campaigns", "audiences"],
      },
      availableCategories: [
        {
          name: "campaigns",
          description: "Campaign management",
          estimatedToolCount: 5,
        },
        {
          name: "audiences",
          description: "Audience segments",
          estimatedToolCount: 3,
        },
      ],
    } satisfies ListToolsCapability,
  },
};

describe("extractListToolsCapability", () => {
  it("returns the capability when server supports filtering", () => {
    const transport = fakeTransport(FILTERING_CAPS);
    const cap = extractListToolsCapability(transport);

    expect(cap).not.toBeNull();
    expect(cap!.supportsFiltering).toBe(true);
    expect(cap!.availableCategories).toHaveLength(2);
    expect(cap!.filterParameter!.name).toBe("category");
  });

  it("returns null when serverCapabilities is null", () => {
    const transport = fakeTransport(null);
    expect(extractListToolsCapability(transport)).toBeNull();
  });

  it("returns null when tools section is missing", () => {
    const transport = fakeTransport({ logging: {} });
    expect(extractListToolsCapability(transport)).toBeNull();
  });

  it("returns null when supportsFiltering is false", () => {
    const transport = fakeTransport({
      tools: { listTools: { supportsFiltering: false } },
    });
    expect(extractListToolsCapability(transport)).toBeNull();
  });

  it("returns null when listTools is missing entirely", () => {
    const transport = fakeTransport({ tools: { listChanged: true } });
    expect(extractListToolsCapability(transport)).toBeNull();
  });
});

describe("buildCategoryTools", () => {
  it("returns tools_list meta-tool when server supports filtering", async () => {
    const transport = fakeTransport(FILTERING_CAPS);
    const client = fakeMcpClient();

    const result = await buildCategoryTools(client as any, transport);

    expect(result.mode).toBe("category");
    expect(result.tools).toHaveProperty("tools_list");
    expect(client.tools).not.toHaveBeenCalled();
  });

  it("falls back to flat tools when server does not support filtering", async () => {
    const transport = fakeTransport(null);
    const flatTools = { list_audiences: {}, create_audience: {} };
    const client = fakeMcpClient(flatTools);

    const result = await buildCategoryTools(client as any, transport);

    expect(result.mode).toBe("flat");
    expect(result.tools).toBe(flatTools);
    expect(client.tools).toHaveBeenCalledTimes(1);
  });

  it("tools_list execute calls listTools with category and merges discovered tools", async () => {
    const transport = fakeTransport(FILTERING_CAPS);
    const client = fakeMcpClient();

    const { tools } = await buildCategoryTools(client as any, transport);
    const toolsList = tools.tools_list as {
      execute: (args: Record<string, unknown>) => Promise<string>;
    };

    const response = await toolsList.execute({ category: "campaigns" });

    expect(client.listTools).toHaveBeenCalledWith({
      params: { category: "campaigns" },
    });
    expect(client.toolsFromDefinitions).toHaveBeenCalled();
    expect(response).toContain("list_workflows");
    expect(response).toContain("execute_workflow");
    expect(tools).toHaveProperty("list_workflows");
    expect(tools).toHaveProperty("execute_workflow");
  });

  it("tools_list execute does not duplicate already-discovered tools", async () => {
    const transport = fakeTransport(FILTERING_CAPS);
    const client = fakeMcpClient();

    const { tools } = await buildCategoryTools(client as any, transport);
    const toolsList = tools.tools_list as {
      execute: (args: Record<string, unknown>) => Promise<string>;
    };

    await toolsList.execute({ category: "campaigns" });
    const secondResponse = await toolsList.execute({ category: "campaigns" });

    expect(secondResponse).toContain("No new tools found");
  });
});
