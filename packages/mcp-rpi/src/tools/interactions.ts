import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { components } from "../client/rpi-types.js";
import { createToolRegistrar } from "../tool-categories.js";
import { targetUrlOf } from "./generated-shared.js";
import {
  searchFileInfos,
  enrichMatchesWithFullPath,
  fetchFileInfo,
} from "../client/search.js";
import { pollUntilTerminal } from "../client/polling.js";
import { mapResultsToCards } from "./response-shapes.js";
import {
  withRetryOn429,
  collectReportPages,
  summarizeInteractionReports,
  fetchRunCounts,
  type RunCountsRequest,
  type RunCountsResults,
  type RunCountGranularity,
  type RunCountExecutionMode,
} from "./run-summary.js";

// Smaller reports page — cheap insurance against a huge single-page payload.
const REPORT_PAGE_SIZE = 50;
// HARD per-call timeout: no single RPI fetch can stall the tool past this. It
// defends the (good) reports/interaction endpoint against a pathologically
// large single-page payload — on abort the collector degrades to a partial
// result rather than hanging past the 240s transport ceiling (#27897).
const PER_CALL_TIMEOUT_MS = 10_000;

/** Run `fn` with an AbortSignal that fires after `ms` — a hard per-call ceiling. */
async function withCallTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

type WorkflowInfo = components["schemas"]["WorkflowInfoJsonResponseMessage"];
type WorkflowInfos = components["schemas"]["WorkflowInfosJsonResponseMessage"];
type InteractionWorkflowInstances =
  components["schemas"]["InteractionWorkflowInstancesJsonResponseMessage"];
type ReportSearchResults =
  components["schemas"]["WorkflowSummarySearchResultsJsonResponseMessage"];

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

/**
 * Workflow-instance statuses that mean "done". The RPI enum is wide — these
 * are the ones that terminate polling. Anything else counts as pending.
 */
const TERMINAL_COMPLETE = new Set<string>([
  "Completed",
  "TestCompleted",
  "RolledBack",
  "Deactivated",
  "Expired",
]);
const TERMINAL_FAIL = new Set<string>([
  "Failed",
  "TestFailed",
  "Stopped",
  "TestStopped",
  "Terminated",
  "RollBackFailed",
  "StatusError",
  "FailedToRetrieveStatus",
]);

const INTERACTION_FILE_TYPE = "Interaction";

// ---------------------------------------------------------------------------
// Shared input schemas — consistent with audiences/clients
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
// Tool registration
// ---------------------------------------------------------------------------

export function registerInteractionTools(
  server: McpServer,
  rpiClient: RPIApiClient,
) {
  const registerTool = createToolRegistrar(server, "interactions");

  // =========================================================================
  // Discovery (file-system-backed)
  // =========================================================================

  registerTool(
    "list_interactions",
    {
      _meta: { endpoints: ["/client/file-system/search-file-infos"] },
      title: "List Interactions",
      description:
        "Search interactions in the RPI instance. Uses POST /client/file-system/search-file-infos with fileTypeFilters=[\"Interaction\"]. Returns a card view `{id, name, description, parentFolderName}` per item by default; pass `verbose: true` to get the full RPI response. Supports server-side pagination and name filtering.",
      inputSchema: {
        pageNumber: pageNumberSchema,
        pageSize: pageSizeSchema,
        nameFilter: z
          .string()
          .optional()
          .describe("Substring filter on interaction name (case-insensitive via RPI search)"),
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
        const raw = await searchFileInfos(
          rpiClient,
          userToken,
          {
            fileTypes: [INTERACTION_FILE_TYPE],
            searchString: nameFilter && nameFilter.length > 0 ? nameFilter : "*",
            pageNumber,
            pageSize,
            folderId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        const shaped = verbose
          ? raw
          : mapResultsToCards(raw, "results", ["parentFolderName"]);
        return jsonContent(shaped);
      } catch (error) {
        return errorContent("Error listing interactions", error);
      }
    },
  );

  // =========================================================================
  // Interaction RUNS (workflow instances) — the execution history behind the
  // interactions, powering "runs this month / test vs prod" dashboards.
  //
  // NOTE: the raw list_interaction_runs tool was REMOVED (#27897) — dumping raw
  // runs via the super-linear workflow-instances endpoint (probe: 10 rows ~13s,
  // 25 ~20s, 255 → >120s timeout) is unusable. The sole run-data tool is
  // summarize_interaction_runs: 'summary' (default) is built from the fast,
  // complete reports/interaction endpoint; 'daily' grinds workflow-instances at
  // PS=10 in small date-chunks ONLY for an explicit per-day trend (slow, ~1 month
  // cap, bounded + partial-on-budget).
  // =========================================================================

  registerTool(
    "summarize_interaction_runs",
    {
      _meta: { endpoints: ["/client/files/reports/interaction"] },
      title: "Summarize Interaction Runs",
      description:
        "Aggregate interactions over a date range SERVER-SIDE — returns COMPUTED figures, not a raw list, complete and never invents numbers. `fromDate` and `toDate` are REQUIRED. Fast (~1-2s), built purely from the reports/interaction endpoint: returns totalRuns, activeInteractions, testInteractions + productionInteractions (INTERACTION counts by environment — for a Test-vs-Production doughnut), and runsPerInteraction (top-10 interactions by run count {name, runs, type} — for a horizontal bar). Use for a per-INTERACTION breakdown (which interactions ran most, test vs production). For counts-over-TIME (per day/week/month) use get_interaction_run_counts instead. If `truncated` is true relay `truncationNote` (figures are partial). Read-only.",
      inputSchema: {
        fromDate: z
          .string()
          .min(1)
          .describe("Start of the date range, inclusive — e.g. '2026-08-01' or an ISO date-time. REQUIRED."),
        toDate: z
          .string()
          .min(1)
          .describe("End of the date range, inclusive — e.g. '2026-08-31' or an ISO date-time. REQUIRED."),
        clientId: clientIdSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fromDate, toDate, clientId }, extra) => {
      const userToken = extra.authInfo?.token;
      const baseUrl = targetUrlOf(extra);
      try {
        // The fast reports path, built PURELY from reports/interaction: complete,
        // server-computed, ~1-2s, and cannot hang. (Counts-over-TIME are the
        // separate get_interaction_run_counts tool — RPI's server-side GROUP BY.)
        // executionOption doesn't split test/prod (association isTest does, per the
        // probe) — pick either; "Production" is arbitrary. returnWorkflowInfos:false
        // still returns the workflowAssociations (with isTest) we classify on.
        const reportPage = (pageNumber: number) =>
          withRetryOn429(
            () =>
              withCallTimeout(PER_CALL_TIMEOUT_MS, (signal) =>
                rpiClient.post<ReportSearchResults>(
                  userToken,
                  "/client/files/reports/interaction",
                  {
                    pageNumber,
                    pageSize: REPORT_PAGE_SIZE,
                    includeDeletedFiles: false,
                    includeUnexecutedInteractions: false,
                    applyFolderPermissions: false,
                    returnWorkflowInfos: false,
                    fromActivityDate: fromDate,
                    toActivityDate: toDate,
                    status: "AllStatuses",
                    dateFilterOption: "LastActivityEventDate",
                    executionOption: "Production",
                  },
                  { clientId, baseUrl, signal },
                ),
              ),
            {
              onRetry: ({ attempt, waitMs, retryAfterMs }) =>
                console.error(
                  `[summarize_interaction_runs] reports 429 backoff attempt=${attempt} ` +
                    `retryAfterMs=${retryAfterMs ?? "none"} sleepMs=${waitMs} page=${pageNumber}`,
                ),
            },
          );

        // Paginate reports (bounded: page-cap + wall-clock budget + per-call
        // timeout) → aggregate the interaction dashboard. truncated only if the
        // reports pagination itself is bounded out (very dense tenant).
        const { rows, truncated } = await collectReportPages(reportPage, { budgetMs: 20_000 });
        const summary = summarizeInteractionReports(rows, { fromDate, toDate, truncated });
        return jsonContent(summary);
      } catch (error) {
        return errorContent("Error summarizing interaction runs", error);
      }
    },
  );

  // =========================================================================
  // Interaction run COUNTS over time (#27957 / RPI 7.8). Server-side GROUP BY on
  // POST reports/interaction/run-counts → small, date-ordered buckets by time +
  // execution mode. THE data source for a per-day/week/month runs dashboard
  // (replaces the interim daily grind). One fast call, complete, never invents.
  // =========================================================================

  registerTool(
    "get_interaction_run_counts",
    {
      _meta: { endpoints: ["/client/files/reports/interaction/run-counts"] },
      title: "Get Interaction Run Counts",
      description:
        "Count interaction RUNS over a date range, bucketed by TIME and execution mode — RPI computes the GROUP BY server-side (fast, one call). This is THE tool for a runs-over-time dashboard/trend. `fromDate` and `toDate` are REQUIRED (UTC, inclusive). `granularity` sets the bucket size (Day/Week/Month, default Day). `executionMode` filters (All/Test/Production, default All). Returns `results` — date-ordered buckets, each `{date, executionModes:[{executionMode, resultsCount}], totalRuns}` — plus overall `executionModes` totals and `totalRuns` for the whole range. For a per-INTERACTION breakdown (which interactions ran most) use summarize_interaction_runs instead. Read-only.",
      inputSchema: {
        fromDate: z
          .string()
          .min(1)
          .describe("Start of the date range, inclusive (UTC) — e.g. '2026-08-01' or an ISO date-time. REQUIRED."),
        toDate: z
          .string()
          .min(1)
          .describe("End of the date range, inclusive (UTC) — e.g. '2026-08-31' or an ISO date-time. REQUIRED."),
        granularity: z
          .enum(["Day", "Week", "Month"])
          .default("Day")
          .describe("Time bucket size: 'Day' (default), 'Week' (Mon-start), or 'Month'."),
        executionMode: z
          .enum(["All", "Test", "Production"])
          .default("All")
          .describe("Which runs to count: 'All' (default), 'Test', or 'Production'."),
        clientId: clientIdSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fromDate, toDate, granularity, executionMode, clientId }, extra) => {
      const userToken = extra.authInfo?.token;
      const baseUrl = targetUrlOf(extra);
      try {
        const post = (body: RunCountsRequest) =>
          withRetryOn429(
            () =>
              withCallTimeout(PER_CALL_TIMEOUT_MS, (signal) =>
                rpiClient.post<RunCountsResults>(
                  userToken,
                  "/client/files/reports/interaction/run-counts",
                  body,
                  { clientId, baseUrl, signal },
                ),
              ),
            {
              onRetry: ({ attempt, waitMs, retryAfterMs }) =>
                console.error(
                  `[get_interaction_run_counts] 429 backoff attempt=${attempt} ` +
                    `retryAfterMs=${retryAfterMs ?? "none"} sleepMs=${waitMs}`,
                ),
            },
          );
        const results = await fetchRunCounts(post, {
          fromDate,
          toDate,
          granularity: granularity as RunCountGranularity,
          executionMode: executionMode as RunCountExecutionMode,
        });
        return jsonContent(results);
      } catch (error) {
        return errorContent("Error getting interaction run counts", error);
      }
    },
  );

  registerTool(
    "get_interaction_by_id",
    {
      _meta: { endpoints: ["/client/files/interaction"] },
      title: "Get Interaction by ID",
      description:
        "Fetch a single interaction's full detail by its RPI ID via GET /client/files/interaction.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI ID of the interaction"),
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
    async ({ interactionId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction",
          { ID: interactionId },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting interaction by ID", error);
      }
    },
  );

  registerTool(
    "get_interaction_by_name",
    {
      _meta: { endpoints: ["/client/file-system/search-file-infos"] },
      title: "Get Interaction by Name",
      description:
        "Find interactions by exact (case-insensitive) name. Uses POST /client/file-system/search-file-infos. Returns `{found: false, name}` when no match, or `{found: true, matches: [...]}` when 1+ — `matches` is always an array (length 1 is common; 2+ means the same name exists in multiple folders, surface `fullPath` (the full folder path, resolved per match) and ask the user to pick). Each match carries `fullPath` and `parentFolderName`; call get_interaction_by_id with `matches[i].id` for full detail.",
      inputSchema: {
        name: z.string().min(1).describe("Exact interaction name (case-insensitive match)"),
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
        const search = await searchFileInfos<{
          results?: Array<{ id?: string | null; name?: string | null }>;
        }>(
          rpiClient,
          userToken,
          {
            fileTypes: [INTERACTION_FILE_TYPE],
            searchString: name,
            pageNumber: 1,
            pageSize: 255,
            folderId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        const needle = name.toLowerCase();
        const matches = (search?.results ?? []).filter(
          (i) => (i.name ?? "").toLowerCase() === needle,
        );
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
        return errorContent("Error getting interaction by name", error);
      }
    },
  );

  // =========================================================================
  // Sub-resources
  // =========================================================================

  registerTool(
    "get_interaction_activity",
    {
      _meta: { endpoints: ["/client/files/interaction/activity"] },
      title: "Get Interaction Activity",
      description:
        "Get a specific activity within an interaction's workflow association. GET /client/files/interaction/activity.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID within the interaction"),
        activityId: z.string().min(1).describe("The activity ID within the workflow"),
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
      { interactionId, workflowAssociationId, activityId, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction/activity",
          {
            InteractionID: interactionId,
            WorkflowAssociationID: workflowAssociationId,
            ActivityID: activityId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting interaction activity", error);
      }
    },
  );

  registerTool(
    "get_interaction_trigger",
    {
      _meta: { endpoints: ["/client/files/interaction/trigger"] },
      title: "Get Interaction Trigger",
      description:
        "Get the trigger configuration for an interaction's workflow association. GET /client/files/interaction/trigger.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID within the interaction"),
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
    async ({ interactionId, workflowAssociationId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction/trigger",
          {
            InteractionID: interactionId,
            WorkflowAssociationID: workflowAssociationId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting interaction trigger", error);
      }
    },
  );

  registerTool(
    "get_interaction_available_inputs",
    {
      _meta: { endpoints: ["/client/files/interaction/available-inputs"] },
      title: "Get Interaction Available Inputs",
      description:
        "Get the available inputs for a specific activity within an interaction's workflow. GET /client/files/interaction/available-inputs.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID within the interaction"),
        activityId: z.string().min(1).describe("The activity ID within the workflow"),
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
      { interactionId, workflowAssociationId, activityId, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction/available-inputs",
          {
            InteractionID: interactionId,
            WorkflowAssociationID: workflowAssociationId,
            ActivityID: activityId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting interaction available inputs", error);
      }
    },
  );

  registerTool(
    "get_interaction_default_metadata",
    {
      _meta: { endpoints: ["/client/files/interaction/default-metadata"] },
      title: "Get Interaction Default Metadata",
      description:
        "Get the default metadata for a specific activity within an interaction's workflow. GET /client/files/interaction/default-metadata.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID within the interaction"),
        activityId: z.string().min(1).describe("The activity ID within the workflow"),
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
      { interactionId, workflowAssociationId, activityId, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction/default-metadata",
          {
            InteractionID: interactionId,
            WorkflowAssociationID: workflowAssociationId,
            ActivityID: activityId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting interaction default metadata", error);
      }
    },
  );

  registerTool(
    "get_interaction_workflows",
    {
      _meta: { endpoints: ["/client/files/interaction/workflows"] },
      title: "Get Interaction Workflows",
      description:
        "List all workflow associations for a given interaction. GET /client/files/interaction/workflows.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
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
    async ({ interactionId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction/workflows",
          { ID: interactionId },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting interaction workflows", error);
      }
    },
  );

  registerTool(
    "get_interaction_workflow_activities",
    {
      _meta: { endpoints: ["/client/files/interaction/workflow/activities"] },
      title: "Get Interaction Workflow Activities",
      description:
        "List all activities in an interaction's workflow association. GET /client/files/interaction/workflow/activities.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID within the interaction"),
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
    async ({ interactionId, workflowAssociationId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction/workflow/activities",
          {
            InteractionID: interactionId,
            WorkflowAssociationID: workflowAssociationId,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting interaction workflow activities", error);
      }
    },
  );

  // =========================================================================
  // Workflow lifecycle: activate interaction workflows and monitor instances.
  // =========================================================================

  const timeoutSecondsSchema = z
    .number()
    .int()
    .min(5)
    .max(3600)
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe(
      `Max seconds to wait for the workflow to finish (default ${DEFAULT_TIMEOUT_SECONDS}s). The tool polls every 1s. The ceiling is the MCP transport, not this tool: raising it past ~240s means the transport kills the call before this budget is reached.`,
    );

  registerTool(
    "activate_interaction_workflow",
    {
      _meta: { endpoints: ["/client/workflows/interactions/activate-workflow-association"] },
      title: "Activate Interaction Workflow",
      description:
        "Start an interaction's workflow association and return the instance ID without waiting for completion. POST /client/workflows/interactions/activate-workflow-association. Use this for fire-and-forget kickoff; use `run_interaction_workflow` to wait for the result.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID to activate"),
        isSandBox: z
          .boolean()
          .optional()
          .describe(
            "If true, run the workflow in sandbox mode (no production side effects)",
          ),
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
      { interactionId, workflowAssociationId, isSandBox, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const body: Record<string, unknown> = {
          id: interactionId,
          workflowAssociationID: workflowAssociationId,
        };
        if (isSandBox !== undefined) body.isSandBox = isSandBox;
        const result = await rpiClient.post<WorkflowInfo>(
          userToken,
          "/client/workflows/interactions/activate-workflow-association",
          body,
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error activating interaction workflow", error);
      }
    },
  );

  registerTool(
    "run_interaction_workflow",
    {
      _meta: { endpoints: ["/client/workflows/interactions/activate-workflow-association"] },
      title: "Run Interaction Workflow",
      description:
        "Activate an interaction's workflow association, poll the instance summary until the workflow terminates, and return the final status. Combines POST /client/workflows/interactions/activate-workflow-association → poll GET /client/workflows/instances/summary. Returns `{workflowAssociationID, workflowAssociationInstanceID, status}`. Terminal success statuses: Completed, TestCompleted, Deactivated, RolledBack, Expired. Terminal failure statuses include Failed, TestFailed, Stopped, Terminated.",
      inputSchema: {
        interactionId: z.string().min(1).describe("The RPI interaction ID"),
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID to activate"),
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
      {
        interactionId,
        workflowAssociationId,
        isSandBox,
        timeoutSeconds,
        clientId,
        verbose,
      },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const body: Record<string, unknown> = {
          id: interactionId,
          workflowAssociationID: workflowAssociationId,
        };
        if (isSandBox !== undefined) body.isSandBox = isSandBox;

        const workflowInfo = await rpiClient.post<WorkflowInfo>(
          userToken,
          "/client/workflows/interactions/activate-workflow-association",
          body,
          { clientId, verbose: true, baseUrl: targetUrlOf(extra) },
        );
        const waID = workflowInfo.workflowAssociationID;
        const waInstanceID = workflowInfo.workflowAssociationInstanceID;
        if (!waID || waInstanceID === undefined || waInstanceID === null) {
          throw new Error(
            `RPI did not return workflow IDs on activation. Response: ${JSON.stringify(workflowInfo)}`,
          );
        }

        const finalStatus = await pollUntilTerminal<WorkflowInfo>(
          () =>
            rpiClient.get<WorkflowInfo>(
              userToken,
              "/client/workflows/instances/summary",
              { WorkflowAssociationInstanceID: String(waInstanceID) },
              { clientId, verbose: true, baseUrl: targetUrlOf(extra) },
            ),
          {
            intervalMs: 1000,
            timeoutMs: timeoutSeconds * 1000,
            isTerminal: (s) => {
              const v = s.currentStatus ?? "";
              if (TERMINAL_COMPLETE.has(v)) return "completed";
              if (TERMINAL_FAIL.has(v)) return "failed";
              return "pending";
            },
            isNotStarted: (s) => (s.currentStatus ?? "") === "NotStarted",
          },
        );

        return jsonContent({
          workflowAssociationID: waID,
          workflowAssociationInstanceID: waInstanceID,
          status: finalStatus,
        });
      } catch (error) {
        return errorContent("Error running interaction workflow", error);
      }
    },
  );

  registerTool(
    "get_workflow_instance_summary",
    {
      _meta: { endpoints: ["/client/workflows/instances/summary"] },
      title: "Get Workflow Instance Summary",
      description:
        "One-shot status check for a workflow instance (interaction or audience). GET /client/workflows/instances/summary. Useful for custom polling or querying an already-running workflow.",
      inputSchema: {
        workflowAssociationInstanceId: z
          .number()
          .int()
          .describe("The workflow association instance ID (integer)"),
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
    async ({ workflowAssociationInstanceId, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.get<WorkflowInfo>(
          userToken,
          "/client/workflows/instances/summary",
          { WorkflowAssociationInstanceID: String(workflowAssociationInstanceId) },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error getting workflow instance summary", error);
      }
    },
  );

  registerTool(
    "get_interactions_workflow_status",
    {
      _meta: { endpoints: ["/client/workflows/interactions/status"] },
      title: "Get Interactions Workflow Status",
      description:
        "Bulk lookup of the latest workflow status for one or more interactions. POST /client/workflows/interactions/status with `{ ids: [...] }`.",
      inputSchema: {
        interactionIds: z
          .array(z.string().min(1))
          .min(1)
          .describe("Array of RPI interaction IDs to look up"),
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
    async ({ interactionIds, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.post<WorkflowInfos>(
          userToken,
          "/client/workflows/interactions/status",
          { ids: interactionIds },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent(
          "Error getting interactions workflow status",
          error,
        );
      }
    },
  );

  registerTool(
    "get_interaction_workflow_instances",
    {
      _meta: { endpoints: ["/client/workflows/interaction/all-instances"] },
      title: "List Workflow Instances for an Interaction",
      description:
        "List all past and current workflow instances for an interaction, optionally with their result counts. GET /client/workflows/interaction/all-instances. Accepts the interaction's file id (what get_interaction_by_name / list_interactions return) OR its versionControlID — the endpoint keys on versionControlID, so this tool resolves it via file-info internally (passing a file id straight to the endpoint returns an empty list with no error). Use this when the user asks for the LAST / EXISTING / PRIOR counts of an interaction — pick the most recent terminal-state instance from the returned `workflowInstances[]` array and surface its activity result counts. The `get_workflow_instance_summary` tool needs an integer instance ID; this tool is how you obtain that ID (or skip it entirely if `getResultCounts: true` already returns enough).",
      inputSchema: {
        interactionId: z
          .string()
          .min(1)
          .describe(
            "The RPI interaction id — the file id (from get_interaction_by_name / list_interactions) or the versionControlID. The tool resolves the versionControlID via file-info as needed.",
          ),
        getResultCounts: z
          .boolean()
          .default(true)
          .describe(
            "When true (default), each returned instance carries result counts. Set false for a cheaper list-only call.",
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
    async ({ interactionId, getResultCounts, clientId, verbose }, extra) => {
      const userToken = extra.authInfo?.token;
      try {
        // The all-instances endpoint keys on the interaction's versionControlID,
        // which is NOT the same value as its file id. Callers usually hold the
        // file id (that's what get_interaction_by_name / list_interactions
        // return), and passing the file id here returns an EMPTY list with no
        // error — a silent "looks like it never ran" trap. So resolve the
        // versionControlID via file-info first. If file-info fails or carries no
        // versionControlID (e.g. the caller already passed a versionControlID),
        // fall back to the id as given.
        let versionControlID = interactionId;
        try {
          const info = await fetchFileInfo<{ versionControlID?: string | null }>(
            rpiClient,
            userToken,
            interactionId,
            { clientId, verbose: true, baseUrl: targetUrlOf(extra) },
          );
          if (info?.versionControlID) versionControlID = info.versionControlID;
        } catch {
          // Keep the caller-supplied id (it may already be a versionControlID).
        }
        const raw = await rpiClient.get<InteractionWorkflowInstances>(
          userToken,
          "/client/workflows/interaction/all-instances",
          {
            VersionControlID: versionControlID,
            GetResultCounts: String(getResultCounts),
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(raw);
      } catch (error) {
        return errorContent(
          "Error getting interaction workflow instances",
          error,
        );
      }
    },
  );

  registerTool(
    "control_workflow_instance",
    {
      _meta: { endpoints: ["/client/workflows/activity-action"] },
      title: "Control Workflow Instance",
      description:
        "Send a control action (Play, Pause, Rollback, Stop) to a running workflow instance. PATCH /client/workflows/activity-action. Applies to both interaction and audience workflow instances identified by their `workflowAssociationInstanceID`.",
      inputSchema: {
        workflowAssociationInstanceId: z
          .number()
          .int()
          .describe("The workflow association instance ID (integer)"),
        workflowAction: z
          .enum(["Play", "Pause", "Rollback", "Stop"])
          .describe("The control action to request"),
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
      {
        workflowAssociationInstanceId,
        workflowAction,
        clientId,
        verbose,
      },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const result = await rpiClient.patch<WorkflowInfo>(
          userToken,
          "/client/workflows/activity-action",
          {
            workflowAssociationInstanceID: workflowAssociationInstanceId,
            workflowAction,
          },
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent("Error controlling workflow instance", error);
      }
    },
  );

  registerTool(
    "calculate_interaction_next_firing_times",
    {
      _meta: { endpoints: ["/client/files/interaction/calculate/trigger-recurrence/next-firing-times"] },
      title: "Calculate Interaction Next Firing Times",
      description:
        "Calculate the next scheduled firing times for an interaction's workflow trigger. GET /client/files/interaction/calculate/trigger-recurrence/next-firing-times.",
      inputSchema: {
        workflowAssociationId: z
          .string()
          .min(1)
          .describe("The workflow association ID to calculate firing times for"),
        numberOfSchedules: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Optional number of upcoming firing times to return"),
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
      { workflowAssociationId, numberOfSchedules, clientId, verbose },
      extra,
    ) => {
      const userToken = extra.authInfo?.token;
      try {
        const params: Record<string, string> = {
          WorkflowAssociationID: workflowAssociationId,
        };
        if (numberOfSchedules !== undefined) {
          params.NumberOfSchedules = String(numberOfSchedules);
        }
        const result = await rpiClient.get(
          userToken,
          "/client/files/interaction/calculate/trigger-recurrence/next-firing-times",
          params,
          { clientId, verbose, baseUrl: targetUrlOf(extra) },
        );
        return jsonContent(result);
      } catch (error) {
        return errorContent(
          "Error calculating interaction next firing times",
          error,
        );
      }
    },
  );
}
