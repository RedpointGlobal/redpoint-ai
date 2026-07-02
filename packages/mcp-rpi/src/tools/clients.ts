import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { components } from "../client/rpi-types.js";
import { createToolRegistrar } from "../tool-categories.js";
import { mapResultsToCards } from "./response-shapes.js";

type ClusterClients = components["schemas"]["ClusterClientsJsonResponseMessage"];

const CLIENTS_PATH = "/cluster/operations/clients";

const verboseSchema = z
  .boolean()
  .default(false)
  .describe(
    "Return the full unfiltered RPI response. Default false strips verbose metadata ($jsonType, $jsonTypeID, data, fileInfo) to save tokens.",
  );

const clientIdSchema = z
  .string()
  .optional()
  .describe(
    "RPI client ID (X-ClientID context) for this call. Normally injected by the agent; the cluster endpoint ignores it but it's sent for consistency with other RPI tools.",
  );

const pageNumberSchema = z
  .number()
  .int()
  .min(1)
  .default(1)
  .describe("1-based page number");

const pageSizeSchema = z
  .number()
  .int()
  .min(5)
  .max(255)
  .default(10)
  .describe("Results per page — keep at the default 10 (the standard list view). Do NOT set this; lists always return the first 10 (or fewer if fewer match).");

function filterByNameContains<T extends { name?: string | null }>(
  items: T[],
  nameFilter: string,
): T[] {
  const needle = nameFilter.toLowerCase();
  return items.filter((i) => (i.name ?? "").toLowerCase().includes(needle));
}

function findByIdExact<T extends { id?: string | null }>(
  items: T[],
  id: string,
): T | undefined {
  const needle = id.toLowerCase();
  return items.find((i) => (i.id ?? "").toLowerCase() === needle);
}

function findByNameExact<T extends { name?: string | null }>(
  items: T[],
  name: string,
): T | undefined {
  const needle = name.toLowerCase();
  return items.find((i) => (i.name ?? "").toLowerCase() === needle);
}

function paginate<T>(items: T[], pageNumber: number, pageSize: number): T[] {
  const start = (pageNumber - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

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

export function registerClientTools(
  server: McpServer,
  rpiClient: RPIApiClient,
) {
  const registerTool = createToolRegistrar(server, "clients");

  registerTool(
    "list_clients",
    {
      title: "List RPI Clients",
      description:
        "List all RPI clients (tenants/workspaces) visible on the cluster. Useful for discovering valid client IDs to set as RPI_DEFAULT_CLIENT_ID or to pass as the `clientId` override on other tool calls. Calls GET /cluster/operations/clients and filters client-side. Returns a card view `{id, name, description}` per item by default; pass `verbose: true` to get the full RPI response.",
      inputSchema: {
        pageNumber: pageNumberSchema,
        pageSize: pageSizeSchema,
        nameFilter: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter on client name"),
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
    async ({ pageNumber, pageSize, nameFilter, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const all = await rpiClient.get<ClusterClients>(
          userToken,
          CLIENTS_PATH,
          undefined,
          { clientId, verbose },
        );
        const items = ((all?.clients ?? []) as unknown) as Array<{
          id?: string | null;
          name?: string | null;
        }>;
        const filtered =
          nameFilter && nameFilter.length > 0
            ? filterByNameContains(items, nameFilter)
            : items;
        const page = paginate(filtered, pageNumber, pageSize);
        const body = {
          pageNumber,
          pageSize,
          totalCount: filtered.length,
          results: page,
        };
        const shaped = verbose ? body : mapResultsToCards(body, "results");
        return jsonContent(shaped);
      } catch (error) {
        return errorContent("Error listing clients", error);
      }
    },
  );

  registerTool(
    "get_client_by_id",
    {
      title: "Get RPI Client by ID",
      description:
        "Find a single RPI client (tenant/workspace) by its ID. Fetches the full cluster list and matches client-side (case-insensitive exact).",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("The client/tenant ID to look up (case-insensitive)"),
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
        const all = await rpiClient.get<ClusterClients>(
          userToken,
          CLIENTS_PATH,
          undefined,
          { clientId, verbose },
        );
        const items = ((all?.clients ?? []) as unknown) as Array<{
          id?: string | null;
          name?: string | null;
        }>;
        const match = findByIdExact(items, id);
        if (!match) return jsonContent({ found: false, id });
        return jsonContent({ found: true, match });
      } catch (error) {
        return errorContent("Error getting client by ID", error);
      }
    },
  );

  registerTool(
    "get_client_by_name",
    {
      title: "Get RPI Client by Name",
      description:
        "Find a single RPI client (tenant/workspace) by its exact (case-insensitive) name. Fetches the full cluster list and matches client-side.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Exact client name (case-insensitive match)"),
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
    async ({ name, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const all = await rpiClient.get<ClusterClients>(
          userToken,
          CLIENTS_PATH,
          undefined,
          { clientId, verbose },
        );
        const items = ((all?.clients ?? []) as unknown) as Array<{
          id?: string | null;
          name?: string | null;
        }>;
        const match = findByNameExact(items, name);
        if (!match) return jsonContent({ found: false, name });
        return jsonContent({ found: true, match });
      } catch (error) {
        return errorContent("Error getting client by name", error);
      }
    },
  );
}
