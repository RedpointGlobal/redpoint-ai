import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { components } from "../client/rpi-types.js";
import { createToolRegistrar } from "../tool-categories.js";
import { targetUrlOf } from "./generated-shared.js";
import { fetchFileInfo } from "../client/search.js";

type FileStorageItem = components["schemas"]["FileStorageItemJsonResponseMessage"];

const verboseSchema = z
  .boolean()
  .default(false)
  .describe(
    "Return the full unfiltered RPI FileStorageItemJsonResponseMessage. Default false returns a compact card `{id, name, typeName, subTypeName, fullPath, parentFolderName}` to save tokens.",
  );

const clientIdSchema = z
  .string()
  .optional()
  .describe(
    "RPI client ID (tenant/workspace) for this call. Normally injected by the agent; leave unset to use the server default (RPI_DEFAULT_CLIENT_ID).",
  );

function jsonContent(body: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  };
}

function errorContent(label: string, error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${label}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

export function registerFileSystemTools(
  server: McpServer,
  rpiClient: RPIApiClient,
) {
  const registerTool = createToolRegistrar(server, "file-system");

  registerTool(
    "get_file_info_by_id",
    {
      _meta: { endpoints: ["/client/file-system/file-info"] },
      title: "Get File Info by ID",
      description:
        "Look up basic file/object info by its RPI ID — works for ANY file type (audiences, interactions, selection rules, channels, content, etc.). GET /client/file-system/file-info. Default response is a compact card `{id, name, typeName, subTypeName, fullPath, parentFolderName}` — `fullPath` is the object's full path including ancestor folders (this endpoint populates it, unlike search-file-infos); pass verbose:true for the full FileStorageItemJsonResponseMessage. Use this when you just need to resolve a GUID to a human-readable name or full path — it's cheaper than the type-specific getters.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("The RPI ID (GUID) of the file/object to look up"),
        clientId: clientIdSchema,
        verbose: verboseSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const raw = await fetchFileInfo<FileStorageItem>(
          rpiClient,
          userToken,
          id,
          { clientId, verbose: true, baseUrl: targetUrlOf(extra) },
        );
        if (verbose) return jsonContent(raw);
        return jsonContent({
          id: raw.id,
          name: raw.name,
          typeName: raw.typeName,
          subTypeName: raw.subTypeName,
          fullPath: raw.fullPath,
          parentFolderName: raw.parentFolderName,
        });
      } catch (error) {
        return errorContent("Error getting file info", error);
      }
    },
  );
}
