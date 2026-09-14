import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { components } from "../client/rpi-types.js";
import { createToolRegistrar } from "../tool-categories.js";
import { targetUrlOf } from "./generated-shared.js";
import { searchFileInfos, enrichMatchesWithFullPath } from "../client/search.js";
import { pollUntilTerminal } from "../client/polling.js";
import {
  filterByNameContains,
  filterByNameExact,
  paginate,
} from "./audiences.js";
import { mapResultsToCards } from "./response-shapes.js";

type ClientJobSummary =
  components["schemas"]["ClientJobSummaryJsonResponseMessage"];
type SelectionRuleCountResults =
  components["schemas"]["SelectionRuleCountResultsJsonResponseMessage"];
type WaterfallResults =
  components["schemas"]["SelectionRuleWaterfallResultsJsonResponseMessage"];

// TIMEOUT INVARIANT (do not break): this tool poll budget must be the
// SMALLEST of the three timeouts in the path so a too-long job fails as a
// CLEAN tool-timeout error, not a transport socket/abort kill:
//   this 220s  <  apps/server patched-transport 240s  <  mcp-rpi Bun.serve
//   idleTimeout 255s (Bun's hard ceiling — the binding constraint).
// Was 300 ("matches Java RPI-MCPServer 5 min"): that EXCEEDED both transport
// timeouts, so a long poll was killed by the transport (silent socket death)
// instead of erroring cleanly. Do NOT raise back to 300 without first raising
// the two transport layers — Bun caps idleTimeout at 255s, so 300 is
// structurally impossible to honor here.
const DEFAULT_TIMEOUT_SECONDS = 220;

const SELECTION_RULE_FILE_TYPE = "Selection Rule";

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

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

const subTypeSchema = z
  .enum(["Basic", "Standard"])
  .optional()
  .describe(
    "Optional selection rule subtype filter. 'Basic' = document-database-decision; 'Standard' = standard-selection-rule. Omit to list both.",
  );

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerSelectionRuleTools(
  server: McpServer,
  rpiClient: RPIApiClient,
) {
  const registerTool = createToolRegistrar(server, "selection-rules");

  registerTool(
    "list_selection_rules",
    {
      _meta: { endpoints: ["/client/file-system/search-file-infos"] },
      title: "List Selection Rules",
      description:
        "Search selection rules (both Basic and Standard subtypes) in the RPI instance. Uses POST /client/file-system/search-file-infos with fileTypeFilters=[\"Selection Rule\"]. Returns a card view `{id, name, description, parentFolderName, subTypeName}` per item by default — subTypeName lets you route to get_basic_selection_rule_by_id vs get_standard_selection_rule_by_id. Pass `verbose: true` to get the full RPI response.",
      inputSchema: {
        pageNumber: pageNumberSchema,
        pageSize: pageSizeSchema,
        nameFilter: z
          .string()
          .optional()
          .describe("Substring filter on rule name (case-insensitive via RPI search)"),
        folderId: z
          .string()
          .optional()
          .describe("Restrict the search to a specific folder ID"),
        subType: subTypeSchema,
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
      { pageNumber, pageSize, nameFilter, folderId, subType, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const raw = await searchFileInfos(
          rpiClient,
          userToken,
          {
            fileTypes: [SELECTION_RULE_FILE_TYPE],
            subTypes: subType ? [subType] : undefined,
            searchString: nameFilter && nameFilter.length > 0 ? nameFilter : "*",
            pageNumber,
            pageSize,
            folderId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        const shaped = verbose
          ? raw
          : mapResultsToCards(raw, "results", [
              "parentFolderName",
              "subTypeName",
            ]);
        return jsonContent(shaped);
      } catch (error) {
        return errorContent("Error listing selection rules", error);
      }
    },
  );

  registerTool(
    "get_selection_rule_by_name",
    {
      _meta: { endpoints: ["/client/file-system/search-file-infos"] },
      title: "Get Selection Rule by Name",
      description:
        "Find selection rules by exact (case-insensitive) name. Uses POST /client/file-system/search-file-infos. Returns `{found: false, name}` when no match, or `{found: true, matches: [...]}` when 1+ — `matches` is always an array (length 1 is common; 2+ means the same name exists in multiple folders, surface `fullPath` (the full folder path, resolved per match) and ask the user to pick). Each match carries `fullPath`, `parentFolderName`, and `subTypeName` so you can chain to get_basic_selection_rule_by_id or get_standard_selection_rule_by_id with `matches[i].id`.",
      inputSchema: {
        name: z.string().min(1).describe("Exact rule name (case-insensitive match)"),
        folderId: z
          .string()
          .optional()
          .describe("Restrict the search to a specific folder ID"),
        subType: subTypeSchema,
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
    async ({ name, folderId, subType, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const search = await searchFileInfos<{
          results?: Array<{ id?: string | null; name?: string | null }>;
        }>(
          rpiClient,
          userToken,
          {
            fileTypes: [SELECTION_RULE_FILE_TYPE],
            subTypes: subType ? [subType] : undefined,
            searchString: name,
            pageNumber: 1,
            pageSize: 255,
            folderId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        const matches = filterByNameExact(search?.results ?? [], name);
        if (matches.length === 0) {
          return jsonContent({ found: false, name });
        }
        const enriched = await enrichMatchesWithFullPath(
          rpiClient,
          userToken,
          matches,
          { clientId, verbose: true, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent({ found: true, matches: enriched });
      } catch (error) {
        return errorContent("Error getting selection rule by name", error);
      }
    },
  );

  registerTool(
    "get_basic_selection_rule_by_id",
    {
      _meta: { endpoints: ["/client/files/document-database-decision"] },
      title: "Get Basic Selection Rule by ID",
      description:
        "Fetch a Basic selection rule's full detail by its RPI ID via GET /client/files/document-database-decision. In RPI, Basic selection rules are represented as document-database-decisions.",
      inputSchema: {
        selectionRuleId: z
          .string()
          .min(1)
          .describe("The RPI ID of the Basic selection rule"),
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
    async ({ selectionRuleId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/document-database-decision",
          { ID: selectionRuleId },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent(
          "Error getting basic selection rule by ID",
          error,
        );
      }
    },
  );

  registerTool(
    "get_standard_selection_rule_by_id",
    {
      _meta: { endpoints: ["/client/files/standard-selection-rule"] },
      title: "Get Standard Selection Rule by ID",
      description:
        "Fetch a Standard selection rule's full detail by its RPI ID via GET /client/files/standard-selection-rule.",
      inputSchema: {
        selectionRuleId: z
          .string()
          .min(1)
          .describe("The RPI ID of the Standard selection rule"),
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
    async ({ selectionRuleId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/standard-selection-rule",
          { ID: selectionRuleId },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent(
          "Error getting standard selection rule by ID",
          error,
        );
      }
    },
  );

  // =========================================================================
  // Lifecycle tools: start a job, poll status until terminal, return results.
  // Job status enum from RPI: "WaitingExecution" | "Executing" | "Completed" | "Failed".
  // =========================================================================

  const timeoutSecondsSchema = z
    .number()
    .int()
    .min(5)
    .max(3600)
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe(
      `Max seconds to wait for the job to finish (default ${DEFAULT_TIMEOUT_SECONDS}s). The tool polls every 1s. The ceiling is the MCP transport, not this tool: raising it past ~240s means the transport kills the call before this budget is reached.`,
    );

  async function runSelectionRuleJob<TResults>(
    userToken: string | undefined,
    startPath: string,
    resultsPath: string,
    selectionRuleId: string,
    timeoutSeconds: number,
    clientId: string | undefined,
    verbose: boolean,
    baseUrl: string | undefined,
  ): Promise<{ jobId: number; status: ClientJobSummary; results: TResults }> {
    // 1. Kick off the job — RPI returns a ClientJobSummary with the assigned jobID.
    const startResp = await rpiClient.post<ClientJobSummary>(
      userToken,
      startPath,
      { id: selectionRuleId },
      { clientId, verbose: true, baseUrl },
    );
    const jobId = startResp.jobID;
    if (jobId === undefined || jobId === null) {
      throw new Error(
        `RPI did not return a jobID when starting ${startPath}. Response: ${JSON.stringify(startResp)}`,
      );
    }

    // 2. Poll /jobs/job/status every 1s until Completed or Failed.
    const finalStatus = await pollUntilTerminal<ClientJobSummary>(
      () =>
        rpiClient.get<ClientJobSummary>(
          userToken,
          "/client/jobs/job/status",
          { ID: String(jobId) },
          { clientId, verbose: true, baseUrl },
        ),
      {
        intervalMs: 1000,
        timeoutMs: timeoutSeconds * 1000,
        isTerminal: (s) =>
          s.status === "Completed"
            ? "completed"
            : s.status === "Failed"
              ? "failed"
              : "pending",
        isNotStarted: (s) => s.status === "WaitingExecution",
        failureReason: (s) => s.errorMessage ?? s.lastStatusMessage ?? undefined,
      },
    );

    // 3. Fetch results. Count and waterfall jobs persist to *different*
    //    endpoints with different shapes — the caller supplies resultsPath.
    //    Results are keyed by (ID, PageNumber); PageNumber is range-validated
    //    1..2147483647 and omitting it 404s (API-ClientJobResultsNotFound).
    //    Both result sets are single-page (waterfall: isPagingSupported=false;
    //    count: one persisted collection), so page 1 is always complete.
    const results = await rpiClient.get<TResults>(
      userToken,
      resultsPath,
      { ID: String(jobId), PageNumber: "1" },
      { clientId, verbose, baseUrl },
    );

    return { jobId, status: finalStatus, results };
  }

  registerTool(
    "run_selection_rule_count",
    {
      _meta: { endpoints: ["/client/jobs/start/selection-rule-count"] },
      title: "Run Selection Rule Count",
      description:
        "Start a selection-rule count job, poll until complete, and return the count. Works for both Basic and Standard selection rules (the count job takes a rule ID regardless of subtype). Combines POST /client/jobs/start/selection-rule-count → poll GET /client/jobs/job/status → GET /client/jobs/results/selection-rule-count-results. Returns `{jobId, status, results}`. Fails with a timeout error if the job does not finish within `timeoutSeconds` (default 300s).",
      inputSchema: {
        selectionRuleId: z
          .string()
          .min(1)
          .describe("The RPI ID of the selection rule (Basic or Standard)"),
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
    async ({ selectionRuleId, timeoutSeconds, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const out = await runSelectionRuleJob<SelectionRuleCountResults>(
          userToken,
          "/client/jobs/start/selection-rule-count",
          // Selection-rule count jobs persist to the DEDICATED
          // selection-rule-count-results endpoint — NOT the generic
          // /client/jobs/results/count-results (that 404s with
          // ClientJobResultsNotFound even with a valid ID+PageNumber).
          // Exact parallel to the waterfall endpoint distinction.
          "/client/jobs/results/selection-rule-count-results",
          selectionRuleId,
          timeoutSeconds,
          clientId,
          verbose,
          targetUrlOf(extra),
        );
        return jsonContent(out);
      } catch (error) {
        return errorContent("Error running selection rule count", error);
      }
    },
  );

  registerTool(
    "run_selection_rule_waterfall",
    {
      _meta: { endpoints: ["/client/jobs/start/selection-rule-waterfall"] },
      title: "Run Selection Rule Waterfall",
      description:
        "Start a selection-rule waterfall job (step-by-step count breakdown), poll until complete, and return the results. Same lifecycle as run_selection_rule_count but against POST /client/jobs/start/selection-rule-waterfall. Works for both Basic and Standard selection rules. Returns `{jobId, status, results}`.",
      inputSchema: {
        selectionRuleId: z
          .string()
          .min(1)
          .describe("The RPI ID of the selection rule (Basic or Standard)"),
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
    async ({ selectionRuleId, timeoutSeconds, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const out = await runSelectionRuleJob<WaterfallResults>(
          userToken,
          "/client/jobs/start/selection-rule-waterfall",
          "/client/jobs/results/selection-rule-waterfall-results",
          selectionRuleId,
          timeoutSeconds,
          clientId,
          verbose,
          targetUrlOf(extra),
        );
        return jsonContent(out);
      } catch (error) {
        return errorContent("Error running selection rule waterfall", error);
      }
    },
  );

  registerTool(
    "get_selection_rule_sql_count_query",
    {
      _meta: { endpoints: ["/client/files/standard-selection-rule/sqlCountQuery"] },
      title: "Get Selection Rule SQL Count Query",
      description:
        "Fetch the generated SQL COUNT(*) query that RPI would execute for a Standard selection rule, without running a job. GET /client/files/standard-selection-rule/sqlCountQuery. Use this to preview the SQL or debug query generation.",
      inputSchema: {
        selectionRuleId: z
          .string()
          .min(1)
          .describe("The RPI ID of the Standard selection rule"),
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
    async ({ selectionRuleId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/standard-selection-rule/sqlCountQuery",
          { ID: selectionRuleId },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent(
          "Error getting selection rule SQL count query",
          error,
        );
      }
    },
  );

  registerTool(
    "list_basic_selection_rule_document_definitions",
    {
      _meta: { endpoints: ["/client/files/document-database-decision/document-definitions"] },
      title: "List Basic Selection Rule Document Definitions",
      description:
        "List the document definitions available for Basic selection rules (document-database-decisions) in the current tenant. The RPI endpoint takes no query params — returns all available definitions; this tool applies client-side name filtering and pagination. Returns a card view `{id, name, description}` per item by default; pass `verbose: true` to get the full RPI response.",
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
        const all = await rpiClient.get<Record<string, unknown>>(
          userToken,
          "/client/files/document-database-decision/document-definitions",
          undefined,
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        // RPI returns { definitions: [...] } from this endpoint (verified
        // against the live instance); fall back to other envelope keys
        // defensively for forward-compat.
        const rawItems =
          (all?.definitions as unknown[] | undefined) ??
          (all?.objects as unknown[] | undefined) ??
          (all?.results as unknown[] | undefined) ??
          (all?.documentDefinitions as unknown[] | undefined) ??
          [];
        const items = rawItems as Array<{
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
        return errorContent(
          "Error listing basic selection rule document definitions",
          error,
        );
      }
    },
  );
}
