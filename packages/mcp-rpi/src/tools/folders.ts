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
/**
 * Bounds on the walk, which costs one RPI request per folder: at most
 * MAX_FOLDERS folders, MAX_DEPTH levels, and WALK_BUDGET_MS in total (under the
 * 220 s tool budget). Past any of them the walk stops and says so; a folder seen
 * before is not walked again, so a cycle cannot loop. Exported for tests.
 */
export const FOLDER_WALK_LIMITS = { maxFolders: 1000, maxDepth: 32, budgetMs: 150_000 };

export function folderWalkNote(reason: string): string {
  return `Truncated: the folder walk stopped early (${reason}); the list above is partial. Use nameFilter, or browse a subfolder, to narrow it.`;
}

async function walkFolderTree(
  rpiClient: RPIApiClient,
  userToken: string | undefined,
  clientId: string | undefined,
  baseUrl: string | undefined,
  limits = FOLDER_WALK_LIMITS,
): Promise<{ nodes: FolderNode[]; raw: FolderItem[]; truncated: string | null }> {
  const deadline = Date.now() + limits.budgetMs;
  const remaining = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const rootResp = await rpiClient.get<FolderItems>(
    userToken,
    "/client/file-system/folders/root-folders",
    undefined,
    { clientId, verbose: true, baseUrl, signal: remaining() },
  );
  const rootFolders = (rootResp.folders ?? []).slice(0, limits.maxFolders);
  let truncated: string | null = (rootResp.folders ?? []).length > limits.maxFolders ? `more than ${limits.maxFolders} folders` : null;

  const nodes: FolderNode[] = rootFolders.map((f) => toNode(f, null));
  const raw: FolderItem[] = [...rootFolders];
  const seen = new Set(rootFolders.map((f) => f.id).filter(Boolean));
  const queue: Array<{ item: FolderItem; depth: number }> = rootFolders.map((item) => ({ item, depth: 1 }));

  while (queue.length > 0 && !truncated) {
    const { item: next, depth } = queue.shift()!;
    if (!next.id) continue;
    if (depth >= limits.maxDepth) {
      truncated = `deeper than ${limits.maxDepth} levels`;
      break;
    }
    if (Date.now() >= deadline) {
      truncated = `the ${limits.budgetMs / 1000}s budget ran out`;
      break;
    }
    const subResp = await rpiClient.get<FolderItems>(
      userToken,
      "/client/file-system/folders/subfolders",
      { ID: next.id },
      { clientId, verbose: true, baseUrl, signal: remaining() },
    );
    for (const sub of subResp.folders ?? []) {
      if (sub.id && seen.has(sub.id)) continue;
      if (nodes.length >= limits.maxFolders) {
        truncated = `more than ${limits.maxFolders} folders`;
        break;
      }
      if (sub.id) seen.add(sub.id);
      raw.push(sub);
      nodes.push(toNode(sub, next.id));
      queue.push({ item: sub, depth: depth + 1 });
    }
  }

  return { nodes, raw, truncated };
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
        // A truncated walk says so in a second block (the first is unchanged) and is not cached.
        const withNote = (result: ReturnType<typeof jsonContent>, truncated: string | null) =>
          truncated ? { ...result, content: [...result.content, { type: "text" as const, text: folderWalkNote(truncated) }] } : result;
        if (verbose) {
          const { raw, truncated } = await walkFolderTree(rpiClient, userToken, clientId, targetUrlOf(extra));
          const filtered = nameFilter
            ? raw.filter((f) =>
                (f.name ?? "").toLowerCase().includes(nameFilter.toLowerCase()),
              )
            : raw;
          return withNote(jsonContent(filtered), truncated);
        }

        let nodes = folderCache.get(cacheKey);
        let truncated: string | null = null;
        if (!nodes) {
          const walked = await walkFolderTree(rpiClient, userToken, clientId, targetUrlOf(extra));
          nodes = walked.nodes;
          truncated = walked.truncated;
          if (!truncated) folderCache.set(cacheKey, nodes);
        }
        const filtered = nameFilter
          ? nodes.filter((n) =>
              n.name.toLowerCase().includes(nameFilter.toLowerCase()),
            )
          : nodes;
        return withNote(jsonContent(filtered), truncated);
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
