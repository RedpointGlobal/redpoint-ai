import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { components } from "../client/rpi-types.js";
import { createToolRegistrar } from "../tool-categories.js";
import { targetUrlOf } from "./generated-shared.js";
import { folderCache, FolderCache, type FolderNode } from "../client/folder-cache.js";

type FolderItem = components["schemas"]["FolderStorageItemJsonResponseMessage"];
type FolderItems = components["schemas"]["FolderStorageItemsJsonResponseMessage"];
type CreateResponse = components["schemas"]["JsonResponseMessage"];

const verboseSchema = z
  .boolean()
  .default(false)
  .describe(
    "Return the full unfiltered RPI folder records. Default false returns flat `{id, name, fullPath, parentFolderId}` nodes to save tokens.",
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

function toNode(item: FolderItem, parentId: string | null): FolderNode {
  return {
    id: item.id ?? "",
    name: item.name ?? "",
    fullPath: item.fullPath ?? "",
    parentFolderId: parentId,
  };
}

/**
 * Walk the RPI folder tree breadth-first: fetch root folders, then fetch
 * subfolders for each non-leaf node. Returns a flattened list of nodes.
 *
 * Parent linkage is tracked during the walk because the live RPI returns
 * the all-zero UUID sentinel in `parentFolderID` on subfolder listings —
 * we can't reconstruct the tree from the response payload alone.
 */
async function walkFolderTree(
  rpiClient: RPIApiClient,
  userToken: string | undefined,
  clientId: string | undefined,
  baseUrl: string | undefined,
): Promise<{ nodes: FolderNode[]; raw: FolderItem[] }> {
  const rootResp = await rpiClient.get<FolderItems>(
    userToken,
    "/client/file-system/folders/root-folders",
    undefined,
    { clientId, verbose: true, baseUrl },
  );
  const rootFolders = rootResp.folders ?? [];

  const nodes: FolderNode[] = rootFolders.map((f) => toNode(f, null));
  const raw: FolderItem[] = [...rootFolders];
  const queue: FolderItem[] = [...rootFolders];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!next.id) continue;
    const subResp = await rpiClient.get<FolderItems>(
      userToken,
      "/client/file-system/folders/subfolders",
      { ID: next.id },
      { clientId, verbose: true, baseUrl },
    );
    const subs = subResp.folders ?? [];
    for (const sub of subs) {
      raw.push(sub);
      nodes.push(toNode(sub, next.id));
      queue.push(sub);
    }
  }

  return { nodes, raw };
}

export function registerFolderTools(
  server: McpServer,
  rpiClient: RPIApiClient,
) {
  const registerTool = createToolRegistrar(server, "folders");

  registerTool(
    "list_folders",
    {
      _meta: { endpoints: ["/client/file-system/folders/root-folders", "/client/file-system/folders/subfolders"] },
      title: "List Folders",
      description:
        "List all folders in the RPI tenant by walking root + subfolders recursively. Returns flat nodes `{id, name, fullPath, parentFolderId}` by default; pass `verbose: true` for full RPI folder records. Optional case-insensitive substring `nameFilter`. Results are cached in-memory per (user, client) for 5 minutes.",
      inputSchema: {
        nameFilter: z
          .string()
          .optional()
          .describe(
            "Filter folders by name (partial match, case-insensitive). Applied client-side after fetch.",
          ),
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
    async ({ nameFilter, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      const effectiveClientId = clientId ?? "";
      const cacheKey = FolderCache.keyFor(userToken, effectiveClientId);

      try {
        if (verbose) {
          const { raw } = await walkFolderTree(rpiClient, userToken, clientId, targetUrlOf(extra));
          const filtered = nameFilter
            ? raw.filter((f) =>
                (f.name ?? "").toLowerCase().includes(nameFilter.toLowerCase()),
              )
            : raw;
          return jsonContent(filtered);
        }

        let nodes = folderCache.get(cacheKey);
        if (!nodes) {
          const walked = await walkFolderTree(rpiClient, userToken, clientId, targetUrlOf(extra));
          nodes = walked.nodes;
          folderCache.set(cacheKey, nodes);
        }
        const filtered = nameFilter
          ? nodes.filter((n) =>
              n.name.toLowerCase().includes(nameFilter.toLowerCase()),
            )
          : nodes;
        return jsonContent(filtered);
      } catch (error) {
        return errorContent("Error listing folders", error);
      }
    },
  );

  registerTool(
    "create_folder",
    {
      _meta: { endpoints: ["/client/file-system/folder"] },
      title: "Create Folder",
      description:
        "Create a new folder in the RPI tenant via POST /client/file-system/folder. `parentFolderId` is optional — omit to create at the root. Invalidates the user's cached folder tree on success.",
      inputSchema: {
        name: z.string().min(1).describe("Folder name (required)"),
        description: z
          .string()
          .optional()
          .describe("Folder description (optional)"),
        parentFolderId: z
          .string()
          .optional()
          .describe(
            "Parent folder RPI ID. Omit to create at the root. Use list_folders to look up an ID by name.",
          ),
        clientId: clientIdSchema,
        verbose: verboseSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (
      { name, description, parentFolderId, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const body: Record<string, unknown> = { name };
        if (description !== undefined) body.description = description;
        if (parentFolderId !== undefined) body.parentFolderID = parentFolderId;

        const result = await rpiClient.post<CreateResponse>(
          userToken,
          "/client/file-system/folder",
          body,
          { clientId, verbose: true, baseUrl: targetUrlOf(extra) },
        );

        folderCache.invalidate(`${FolderCache.fingerprint(userToken)}:`);

        if (verbose) return jsonContent(result);
        return jsonContent({ id: result.id ?? null });
      } catch (error) {
        return errorContent("Error creating folder", error);
      }
    },
  );
}
