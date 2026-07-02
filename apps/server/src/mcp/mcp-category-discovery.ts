/**
 * MCP category-based tool discovery — C# agent parity.
 *
 * When the MCP server advertises tool categories via `listTools.supportsFiltering`
 * in its initialize response, this module synthesizes a `tools_list` meta-tool
 * that the LLM calls to discover tools by category on-demand.
 *
 * Token savings: instead of loading all tools at once (~1,700+ tokens), the LLM
 * starts with one meta-tool (~100 tokens) and discovers tools by category as needed.
 *
 * Ported from RP-Vercel-Agent v3 (src/mcp-category-discovery.ts).
 * Original C# source: RP-MCP-Agent/Desktop/Services/MCPClient.cs
 *   - CreateToolsListToolFromCapabilities() → buildDescription()
 *   - ListToolsAsync(category) → execute function inside the tool
 */

import { z } from "zod";
import type { MCPClient } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import type {
  ListToolsCapability,
  PatchedTransport,
} from "./patched-transport.js";

export interface CategoryDiscoveryResult {
  tools: Record<string, Tool>;
  mode: "category" | "flat";
}

/**
 * Extract the listTools capability from the transport's captured server capabilities.
 * Returns null if the server doesn't advertise category filtering.
 */
export function extractListToolsCapability(
  transport: PatchedTransport,
): ListToolsCapability | null {
  const caps = transport.serverCapabilities;
  if (!caps) return null;

  const tools = caps.tools as Record<string, unknown> | undefined;
  if (!tools) return null;

  const listTools = tools.listTools as Record<string, unknown> | undefined;
  if (!listTools || listTools.supportsFiltering !== true) return null;

  return listTools as unknown as ListToolsCapability;
}

/**
 * Build the tools_list meta-tool description from server-advertised categories.
 */
function buildDescription(capability: ListToolsCapability): string {
  const parts: string[] = [];

  if (capability.description) {
    parts.push(capability.description);
  } else {
    parts.push(
      "Discover available tools by category. Call this before using any tools.",
    );
  }

  if (capability.availableCategories?.length) {
    parts.push("\nAvailable categories:");
    for (const cat of capability.availableCategories) {
      let line = `- ${cat.name}`;
      if (cat.description) line += `: ${cat.description}`;
      if (cat.estimatedToolCount)
        line += ` (~${cat.estimatedToolCount} tools)`;
      parts.push(line);
    }
  }

  if (capability.filterParameter?.examples?.length) {
    const paramName = capability.filterParameter.name;
    parts.push("\nExamples:");
    for (const example of capability.filterParameter.examples) {
      parts.push(`- ${paramName}='${example}'`);
    }
  }

  return parts.join("\n");
}

/**
 * Build category-based tools if the server supports filtering, otherwise
 * fall back to loading all tools flat.
 *
 * If category filtering is supported, returns a single `tools_list` meta-tool.
 * The LLM calls it with a category → we fetch that category's tools from the
 * server → dynamically merge them into the active tool set.
 */
export async function buildCategoryTools(
  mcpClient: MCPClient,
  transport: PatchedTransport,
): Promise<CategoryDiscoveryResult> {
  const capability = extractListToolsCapability(transport);

  if (!capability) {
    const tools = await mcpClient.tools();
    return { tools: tools as Record<string, Tool>, mode: "flat" };
  }

  const paramName = capability.filterParameter?.name ?? "category";
  const discoveredTools: Record<string, Tool> = {};

  const toolsListTool: Tool = {
    description: buildDescription(capability),
    inputSchema: z.object({
      [paramName]: z.string().describe(
        capability.filterParameter?.description ??
          "Category name to discover tools for",
      ),
    }),
    execute: async (args: Record<string, unknown>) => {
      const filterValue = args[paramName] as string;

      const definitions = await mcpClient.listTools({
        params: { [paramName]: filterValue },
      });

      const newTools = mcpClient.toolsFromDefinitions(definitions);
      const newToolNames: string[] = [];

      for (const [name, tool] of Object.entries(newTools)) {
        if (!(name in discoveredTools)) {
          discoveredTools[name] = tool as Tool;
          newToolNames.push(name);
        }
      }

      if (newToolNames.length === 0) {
        return `No new tools found for category "${filterValue}".`;
      }

      return `Discovered ${newToolNames.length} tools for "${filterValue}": ${newToolNames.join(", ")}. You can now call these tools directly.`;
    },
  };

  discoveredTools.tools_list = toolsListTool;

  return { tools: discoveredTools, mode: "category" };
}
