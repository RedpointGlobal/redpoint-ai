import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { components } from "../client/rpi-types.js";
import { createToolRegistrar } from "../tool-categories.js";
import {
  searchFileInfos,
  enrichMatchesWithFullPath,
  fetchFileInfo,
} from "../client/search.js";
import { pollUntilTerminal } from "../client/polling.js";
import { mapResultsToCards } from "./response-shapes.js";

type WorkflowInfo = components["schemas"]["WorkflowInfoJsonResponseMessage"];
type WorkflowInfos = components["schemas"]["WorkflowInfosJsonResponseMessage"];
type InteractionWorkflowInstances =
  components["schemas"]["InteractionWorkflowInstancesJsonResponseMessage"];

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
          { clientId, verbose },
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

  registerTool(
    "get_interaction_by_id",
    {
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose: true },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose: true },
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
              { clientId, verbose: true },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
            { clientId, verbose: true },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
          { clientId, verbose },
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
