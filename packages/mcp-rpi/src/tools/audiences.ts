import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { components } from "../client/rpi-types.js";
import { createToolRegistrar } from "../tool-categories.js";
import { searchFileInfos, enrichMatchesWithFullPath } from "../client/search.js";
import { pollUntilTerminal } from "../client/polling.js";
import { mapResultsToCards, stripNestedFields } from "./response-shapes.js";

type SearchResults =
  components["schemas"]["FileStorageItemJsonResponseMessageSearchResultsJsonResponseMessage"];
type AudienceDetail = components["schemas"]["DataflowTemplateJsonResponseMessage"];
type AudienceMetadata = components["schemas"]["MetaItemsJsonResponseMessage"];
type AudienceDefinitions =
  components["schemas"]["DataflowTemplateDefinitionsJsonResponseMessage"];
type AudienceDefinition =
  components["schemas"]["DataflowTemplateDefinitionJsonResponseMessage"];
type WorkflowInfo = components["schemas"]["WorkflowInfoJsonResponseMessage"];
type AudienceActivityStatus =
  components["schemas"]["AudienceActivityStatusJsonResponseMessage"];
type WorkflowsBlockInstancesResults =
  components["schemas"]["WorkflowsBlockInstancesResultsJsonResponseMessage"];
type DataflowResultRequest =
  components["schemas"]["DataflowResultRequestJsonResponseMessage"];
type DataflowTestInstances =
  components["schemas"]["DataflowTestInstancesJsonResponseMessage"];
type AudienceExecutionResults =
  components["schemas"]["AudienceExecutionResultsJsonResponseMessage"];

/** Default for run_* lifecycle tools — matches Java RPI-MCPServer (5 min). */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** RPI file-type filter value for audience files. */
const AUDIENCE_FILE_TYPE = "Audience";

/** Pagination + verbose + clientId inputs shared by every audience tool. */
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
    "RPI client ID (tenant/workspace) for this call. Normally injected by the agent; leave unset to use the server default (RPI_DEFAULT_CLIENT_ID).",
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

/** Case-insensitive substring match on `item.name`. */
function filterByNameContains<T extends { name?: string | null }>(
  items: T[],
  nameFilter: string,
): T[] {
  const needle = nameFilter.toLowerCase();
  return items.filter((i) => (i.name ?? "").toLowerCase().includes(needle));
}

/** Case-insensitive exact match on `item.id`. */
function findByIdExact<T extends { id?: string | null }>(
  items: T[],
  id: string,
): T | undefined {
  const needle = id.toLowerCase();
  return items.find((i) => (i.id ?? "").toLowerCase() === needle);
}

/** Case-insensitive exact match on `item.name`. */
function findByNameExact<T extends { name?: string | null }>(
  items: T[],
  name: string,
): T | undefined {
  const needle = name.toLowerCase();
  return items.find((i) => (i.name ?? "").toLowerCase() === needle);
}

/**
 * Case-insensitive exact match on `item.name` — returns ALL matches.
 * RPI permits same-named objects in different folders, so name lookups must
 * surface every collision (not just the first) for the caller to disambiguate.
 */
function filterByNameExact<T extends { name?: string | null }>(
  items: T[],
  name: string,
): T[] {
  const needle = name.toLowerCase();
  return items.filter((i) => (i.name ?? "").toLowerCase() === needle);
}

/** Slice an array by 1-based pageNumber + pageSize. */
function paginate<T>(items: T[], pageNumber: number, pageSize: number): T[] {
  const start = (pageNumber - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** Wrap a result body in the standard MCP tool content response. */
function jsonContent(body: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  };
}

/** Wrap a thrown error in the standard MCP tool error response. */
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

export function registerAudienceTools(
  server: McpServer,
  rpiClient: RPIApiClient,
) {
  const registerTool = createToolRegistrar(server, "audiences");

  // ==========================================================================
  // File-system-backed audiences (server-side search + pagination)
  // ==========================================================================

  registerTool(
    "list_audiences",
    {
      title: "List Audiences",
      description:
        "Search audiences in the RPI instance. Uses POST /client/file-system/search-file-infos with fileTypeFilters=[\"Audience\"]. Returns a card view `{id, name, description, parentFolderName}` per item by default; pass `verbose: true` to get the full RPI response. Supports server-side pagination and name filtering.",
      inputSchema: {
        pageNumber: pageNumberSchema,
        pageSize: pageSizeSchema,
        nameFilter: z
          .string()
          .optional()
          .describe("Substring filter on audience name (case-insensitive via RPI search)"),
        folderId: z
          .string()
          .optional()
          .describe("Restrict the search to a specific folder ID"),
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
    async ({ pageNumber, pageSize, nameFilter, folderId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const raw = await searchFileInfos<SearchResults>(
          rpiClient,
          userToken,
          {
            fileTypes: [AUDIENCE_FILE_TYPE],
            searchString: nameFilter && nameFilter.length > 0 ? nameFilter : "*",
            pageNumber,
            pageSize,
            folderId,
          },
          { clientId, verbose },
        );
        const shaped = verbose
          ? raw
          : mapResultsToCards(raw, "results", ["parentFolderName"]);
        return jsonContent(shaped);
      } catch (error) {
        return errorContent("Error listing audiences", error);
      }
    },
  );

  registerTool(
    "get_audience_by_id",
    {
      title: "Get Audience by ID",
      description:
        "Fetch a single audience's full detail by its RPI ID via GET /client/files/audience.",
      inputSchema: {
        audienceId: z.string().min(1).describe("The RPI ID of the audience"),
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
    async ({ audienceId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get<AudienceDetail>(
          userToken,
          "/client/files/audience",
          { ID: audienceId },
          { clientId, verbose },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting audience by ID", error);
      }
    },
  );

  registerTool(
    "get_audience_by_name",
    {
      title: "Get Audience by Name",
      description:
        "Find audiences by exact (case-insensitive) name. Uses POST /client/file-system/search-file-infos. Returns `{found: false, name}` when no match, or `{found: true, matches: [...]}` when 1+ — `matches` is always an array (length 1 is common; 2+ means the same name exists in multiple folders, surface `fullPath` (the full folder path, resolved per match) and ask the user to pick). Each match carries `fullPath` and `parentFolderName`; call get_audience_by_id with `matches[i].id` for full detail.",
      inputSchema: {
        name: z.string().min(1).describe("Exact audience name (case-insensitive match)"),
        folderId: z
          .string()
          .optional()
          .describe("Restrict the search to a specific folder ID"),
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
    async ({ name, folderId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const search = await searchFileInfos<SearchResults>(
          rpiClient,
          userToken,
          {
            fileTypes: [AUDIENCE_FILE_TYPE],
            searchString: name,
            pageNumber: 1,
            pageSize: 255,
            folderId,
          },
          { clientId, verbose },
        );
        const results = (search.results ?? []) as Array<{
          id?: string | null;
          name?: string | null;
        }>;
        const matches = filterByNameExact(results, name);
        if (matches.length === 0) {
          return jsonContent({ found: false, name });
        }
        const enriched = await enrichMatchesWithFullPath(
          rpiClient,
          userToken,
          matches,
          { clientId, verbose: true },
        );
        return jsonContent({ found: true, matches: enriched });
      } catch (error) {
        return errorContent("Error getting audience by name", error);
      }
    },
  );

  registerTool(
    "get_audience_metadata",
    {
      title: "Get Audience Metadata",
      description:
        "Fetch the metadata configuration for an audience by its RPI ID via GET /client/files/audience/metadata.",
      inputSchema: {
        audienceId: z.string().min(1).describe("The RPI ID of the audience"),
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
    async ({ audienceId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get<AudienceMetadata>(
          userToken,
          "/client/files/audience/metadata",
          { ID: audienceId },
          { clientId, verbose },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting audience metadata", error);
      }
    },
  );

  // ==========================================================================
  // Configuration-backed audience definitions (fetch-all + client-side filter)
  // ==========================================================================

  registerTool(
    "list_audience_definitions",
    {
      title: "List Audience Definitions",
      description:
        "List audience definitions (data-structure templates). RPI's configuration endpoint returns the full set on every call; this tool filters by name and paginates client-side. Returns a card view `{id, name, description}` per item by default; pass `verbose: true` to get the full audience-definition records (including oversize fields like offerHistoryAttributes, metadata.items, trainingSets).",
      inputSchema: {
        pageNumber: pageNumberSchema,
        pageSize: pageSizeSchema,
        nameFilter: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter on definition name"),
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
        const all = await rpiClient.get<AudienceDefinitions>(
          userToken,
          "/client/configuration/audience-definitions",
          undefined,
          { clientId, verbose },
        );
        const items = ((all?.objects ?? []) as unknown) as Array<{
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
        return errorContent("Error listing audience definitions", error);
      }
    },
  );

  registerTool(
    "get_audience_definition_by_id",
    {
      title: "Get Audience Definition by ID",
      description:
        "Find a single audience definition by its RPI ID (case-insensitive equals). Fetches the full list and matches client-side — RPI's configuration endpoint has no by-id query. By default, strips oversize fields (offerHistoryAttributes, trainingSets, metadata.items) for token efficiency. Pass `verbose: true` to include them.",
      inputSchema: {
        audienceDefinitionId: z
          .string()
          .min(1)
          .describe("The RPI ID of the audience definition"),
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
    async ({ audienceDefinitionId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const all = await rpiClient.get<AudienceDefinitions>(
          userToken,
          "/client/configuration/audience-definitions",
          undefined,
          { clientId, verbose },
        );
        const items = ((all?.objects ?? []) as unknown) as Array<{
          id?: string | null;
          name?: string | null;
        }>;
        const match = findByIdExact(items, audienceDefinitionId);
        if (!match) {
          return jsonContent({ found: false, audienceDefinitionId });
        }
        const shaped = verbose
          ? match
          : stripNestedFields(match, [
              "offerHistoryAttributes",
              "trainingSets",
              "metadata.items",
            ]);
        return jsonContent({ found: true, match: shaped });
      } catch (error) {
        return errorContent("Error getting audience definition by ID", error);
      }
    },
  );

  // ==========================================================================
  // Workflow lifecycle — start + wait + fetch (and lower-level helpers).
  // Audience workflows poll AudienceActivityStatus.dataflowInternalStatus with
  // values: "NotStarted" | "Playing" | "Paused" | "Stopped" | "Completed"
  // | "Stopping" | "Failed" | "Pausing".
  // ==========================================================================

  const timeoutSecondsSchema = z
    .number()
    .int()
    .min(5)
    .max(3600)
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe(
      `Max seconds to wait for the workflow to finish (default ${DEFAULT_TIMEOUT_SECONDS}s = 5 min, matches Java RPI-MCPServer). The tool polls every 1s.`,
    );

  registerTool(
    "run_audience_test_workflow",
    {
      title: "Run Audience Test Workflow",
      description:
        "Start an audience's test workflow, poll the activity status until it terminates, then fetch the block instance results (record counts per block). Combines POST /client/workflows/audiences/activate-workflow-association-test → poll GET /client/workflows/audiences/activity/status → GET /client/workflows/audiences/blocks-instance-results. Returns `{workflowAssociationID, workflowAssociationInstanceID, activityID, status, blockResults}`. Port of the Java `audienceExecuteWorkflowAndWait` tool.",
      inputSchema: {
        audienceId: z.string().min(1).describe("The RPI ID of the audience"),
        isSandBox: z
          .boolean()
          .optional()
          .describe(
            "If true, run the workflow in sandbox mode (no production side effects)",
          ),
        timeoutSeconds: timeoutSecondsSchema,
        clientId: clientIdSchema,
        verbose: verboseSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (
      { audienceId, isSandBox, timeoutSeconds, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        // 1. Kick off the test workflow.
        const workflowInfo = await rpiClient.post<WorkflowInfo>(
          userToken,
          "/client/workflows/audiences/activate-workflow-association-test",
          isSandBox !== undefined
            ? { id: audienceId, isSandBox }
            : { id: audienceId },
          { clientId, verbose: true },
        );
        const waID = workflowInfo.workflowAssociationID;
        const waInstanceID = workflowInfo.workflowAssociationInstanceID;
        if (!waID || waInstanceID === undefined || waInstanceID === null) {
          throw new Error(
            `RPI did not return workflow IDs on activation. Response: ${JSON.stringify(workflowInfo)}`,
          );
        }

        // 2. Poll the activity status. RPI requires ActivityID on this endpoint,
        // and for an audience workflow ActivityID is the workflowAssociationID
        // (waID) — not a separate activity GUID. Omitting it fails the poll with
        // "ActivityID is required and can't be empty".
        const finalStatus = await pollUntilTerminal<AudienceActivityStatus>(
          () =>
            rpiClient.get<AudienceActivityStatus>(
              userToken,
              "/client/workflows/audiences/activity/status",
              {
                WorkflowAssociationInstanceID: String(waInstanceID),
                ActivityID: waID,
              },
              { clientId, verbose: true },
            ),
          {
            intervalMs: 1000,
            timeoutMs: timeoutSeconds * 1000,
            isTerminal: (s) => {
              const v = s.dataflowInternalStatus;
              if (v === "Completed") return "completed";
              if (v === "Failed" || v === "Stopped") return "failed";
              return "pending";
            },
            isNotStarted: (s) => s.dataflowInternalStatus === "NotStarted",
          },
        );
        // The blocks-instance-results (counts) endpoint requires a non-empty
        // ActivityID, but the audience status poll frequently omits activityID.
        // In RPI the audience counts request keys ActivityID to the
        // workflowAssociationID — so fall back to waID when the status carries
        // no activityID, otherwise the counts call fails with
        // "ActivityID is required and can't be empty".
        const activityID = finalStatus.activityID || waID;

        // 3. Fetch block instance results.
        const blockResults =
          await rpiClient.get<WorkflowsBlockInstancesResults>(
            userToken,
            "/client/workflows/audiences/blocks-instance-results",
            {
              ActivityID: activityID,
              WorkflowAssociationInstanceID: String(waInstanceID),
            },
            { clientId, verbose },
          );

        return jsonContent({
          workflowAssociationID: waID,
          workflowAssociationInstanceID: waInstanceID,
          activityID,
          status: finalStatus,
          blockResults,
        });
      } catch (error) {
        return errorContent("Error running audience test workflow", error);
      }
    },
  );

  registerTool(
    "get_audience_workflow_activity_status",
    {
      title: "Get Audience Workflow Activity Status",
      description:
        "One-shot status check for an audience workflow activity. GET /client/workflows/audiences/activity/status. Useful for custom polling or inspecting an already-running workflow without waiting for it.",
      inputSchema: {
        workflowAssociationInstanceId: z
          .number()
          .int()
          .describe("The workflow association instance ID (integer)"),
        activityId: z
          .string()
          .optional()
          .describe("Optional specific activity ID to scope the status check"),
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
    async (
      { workflowAssociationInstanceId, activityId, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const params: Record<string, string> = {
          WorkflowAssociationInstanceID: String(workflowAssociationInstanceId),
        };
        if (activityId) params.ActivityID = activityId;
        const result = await rpiClient.get<AudienceActivityStatus>(
          userToken,
          "/client/workflows/audiences/activity/status",
          params,
          { clientId, verbose },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent(
          "Error getting audience workflow activity status",
          error,
        );
      }
    },
  );

  registerTool(
    "get_audience_workflow_block_results",
    {
      title: "Get Audience Workflow Block Results",
      description:
        "Fetch detailed block instance results for an audience workflow run. GET /client/workflows/audiences/blocks-instance-results. Returns record counts per block in the dataflow.",
      inputSchema: {
        workflowAssociationInstanceId: z
          .number()
          .int()
          .describe("The workflow association instance ID (integer)"),
        activityId: z
          .string()
          .min(1)
          .describe(
            "The activity ID within the workflow instance. For an audience counts request set this to the workflowAssociationID — RPI keys ActivityID to the workflowAssociationID here (it is not a separate activity GUID).",
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
    async (
      { workflowAssociationInstanceId, activityId, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get<WorkflowsBlockInstancesResults>(
          userToken,
          "/client/workflows/audiences/blocks-instance-results",
          {
            ActivityID: activityId,
            WorkflowAssociationInstanceID: String(workflowAssociationInstanceId),
          },
          { clientId, verbose },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent(
          "Error getting audience workflow block results",
          error,
        );
      }
    },
  );

  registerTool(
    "get_audience_workflow_results",
    {
      title: "Get Audience Workflow Results",
      description:
        "Fetch comprehensive audience workflow results — optionally including the dataflow template XML, the status summary, and the activity results. POST /client/workflows/audiences/results (this is a POST with query parameters, not a JSON body).",
      inputSchema: {
        workflowAssociationInstanceId: z
          .number()
          .int()
          .describe("The workflow association instance ID (integer)"),
        activityId: z
          .string()
          .min(1)
          .describe(
            "The activity ID within the workflow instance. For an audience counts/results request set this to the workflowAssociationID — RPI keys ActivityID to the workflowAssociationID here (it is not a separate activity GUID).",
          ),
        isDataflowTemplateRequired: z
          .boolean()
          .optional()
          .describe("Include the dataflow template XML in the response"),
        isDataflowStatusSummaryRequired: z
          .boolean()
          .optional()
          .describe("Include the status summary in the response"),
        areActivityResultsRequired: z
          .boolean()
          .optional()
          .describe("Include the activity-level results in the response"),
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
    async (
      {
        workflowAssociationInstanceId,
        activityId,
        isDataflowTemplateRequired,
        isDataflowStatusSummaryRequired,
        areActivityResultsRequired,
        clientId,
        verbose,
      },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const params: Record<string, string> = {
          WorkflowAssociationInstanceID: String(workflowAssociationInstanceId),
          ActivityID: activityId,
        };
        if (isDataflowTemplateRequired !== undefined) {
          params.IsDataflowTemplateRequired = String(isDataflowTemplateRequired);
        }
        if (isDataflowStatusSummaryRequired !== undefined) {
          params.IsDataflowStatusSummaryRequired = String(
            isDataflowStatusSummaryRequired,
          );
        }
        if (areActivityResultsRequired !== undefined) {
          params.AreActivityResultsRequired = String(areActivityResultsRequired);
        }
        const result = await rpiClient.post<DataflowResultRequest>(
          userToken,
          "/client/workflows/audiences/results",
          undefined,
          { clientId, verbose },
          params,
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting audience workflow results", error);
      }
    },
  );

  registerTool(
    "list_audience_test_instances",
    {
      title: "List Audience Test Instances",
      description:
        "List the historical test workflow instances for an audience. GET /client/workflows/audiences/test-instances. Each entry corresponds to a past run of the audience's test workflow.",
      inputSchema: {
        audienceId: z.string().min(1).describe("The RPI ID of the audience"),
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
    async ({ audienceId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get<DataflowTestInstances>(
          userToken,
          "/client/workflows/audiences/test-instances",
          { ID: audienceId },
          { clientId, verbose },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error listing audience test instances", error);
      }
    },
  );

  registerTool(
    "get_audience_execution_results",
    {
      title: "Get Audience Execution Results",
      description:
        "Fetch historical execution results for an audience, with optional date range and scope filters. POST /client/workflows/audiences/execution-results (POST with query parameters — no JSON body). Use `workflowAssociationInstanceId` to scope to a specific past run.",
      inputSchema: {
        audienceId: z.string().min(1).describe("The RPI ID of the audience"),
        includeAudienceTests: z
          .boolean()
          .optional()
          .describe("Include results from audience test runs"),
        includeProductionInteractions: z
          .boolean()
          .optional()
          .describe("Include results from production interaction runs"),
        includeTestInteractions: z
          .boolean()
          .optional()
          .describe("Include results from test interaction runs"),
        minDateUtc: z
          .string()
          .optional()
          .describe("ISO-8601 lower bound (UTC) on result date"),
        maxDateUtc: z
          .string()
          .optional()
          .describe("ISO-8601 upper bound (UTC) on result date"),
        maxNumberOfResults: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Cap on the number of results returned"),
        workflowAssociationInstanceId: z
          .number()
          .int()
          .optional()
          .describe("Scope to a single workflow instance"),
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
    async (
      {
        audienceId,
        includeAudienceTests,
        includeProductionInteractions,
        includeTestInteractions,
        minDateUtc,
        maxDateUtc,
        maxNumberOfResults,
        workflowAssociationInstanceId,
        clientId,
        verbose,
      },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const params: Record<string, string> = { AudienceID: audienceId };
        if (includeAudienceTests !== undefined) {
          params["AudienceResultsSearchArgs.IncludeAudienceTests"] = String(
            includeAudienceTests,
          );
        }
        if (includeProductionInteractions !== undefined) {
          params["AudienceResultsSearchArgs.IncludeProductionInteractions"] =
            String(includeProductionInteractions);
        }
        if (includeTestInteractions !== undefined) {
          params["AudienceResultsSearchArgs.IncludeTestInteractions"] = String(
            includeTestInteractions,
          );
        }
        if (minDateUtc) {
          params["AudienceResultsSearchArgs.MinDateUTC"] = minDateUtc;
        }
        if (maxDateUtc) {
          params["AudienceResultsSearchArgs.MaxDateUTC"] = maxDateUtc;
        }
        if (maxNumberOfResults !== undefined) {
          params["AudienceResultsSearchArgs.MaxNumberOfResults"] = String(
            maxNumberOfResults,
          );
        }
        if (workflowAssociationInstanceId !== undefined) {
          params["AudienceResultsSearchArgs.WorkflowAssociationInstanceID"] =
            String(workflowAssociationInstanceId);
        }
        const result = await rpiClient.post<AudienceExecutionResults>(
          userToken,
          "/client/workflows/audiences/execution-results",
          undefined,
          { clientId, verbose },
          params,
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting audience execution results", error);
      }
    },
  );

  registerTool(
    "get_audience_definition_by_name",
    {
      title: "Get Audience Definition by Name",
      description:
        "Find a single audience definition by its exact (case-insensitive) name. Fetches the full list and matches client-side. By default, strips oversize fields (offerHistoryAttributes, trainingSets, metadata.items) for token efficiency. Pass `verbose: true` to include them.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Exact audience definition name (case-insensitive match)"),
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
        const all = await rpiClient.get<AudienceDefinitions>(
          userToken,
          "/client/configuration/audience-definitions",
          undefined,
          { clientId, verbose },
        );
        const items = ((all?.objects ?? []) as unknown) as Array<{
          id?: string | null;
          name?: string | null;
        }>;
        const match = findByNameExact(items, name);
        if (!match) {
          return jsonContent({ found: false, name });
        }
        const shaped = verbose
          ? match
          : stripNestedFields(match, [
              "offerHistoryAttributes",
              "trainingSets",
              "metadata.items",
            ]);
        return jsonContent({ found: true, match: shaped });
      } catch (error) {
        return errorContent("Error getting audience definition by name", error);
      }
    },
  );
}

// Re-export for potential use elsewhere (tests, lifting to shared config helper)
export {
  filterByNameContains,
  filterByNameExact,
  findByIdExact,
  findByNameExact,
  paginate,
};

// Silence unused warning when `AudienceDefinition` type is inlined.
export type { AudienceDefinition };
