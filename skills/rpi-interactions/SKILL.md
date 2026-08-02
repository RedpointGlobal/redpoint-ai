---
name: rpi-interactions
title: RPI Interactions
description: Marketing interactions — a.k.a. activations, campaigns, or journeys — and their workflows. Covers "list my interactions / activations", "when does each interaction fire next?", "show me scheduled triggers", "what's currently running", workflow activate/pause/stop/rollback, and trigger schedule calculations.
type: action
mcpToolFilter:
  - list_interactions
  - get_interaction_by_id
  - get_interaction_by_name
  - get_interaction_activity
  - get_interaction_trigger
  - get_interaction_available_inputs
  - get_interaction_default_metadata
  - get_interaction_workflows
  - get_interaction_workflow_activities
  - get_workflow_instance_summary
  - get_interactions_workflow_status
  - get_interaction_workflow_instances
  - calculate_interaction_next_firing_times
  - get_file_info_by_id
  - get_audience_by_id
operations:
  list: [list_interactions]
  get: [list_interactions, get_interaction_by_id, get_interaction_by_name, get_interaction_activity, get_file_info_by_id, get_audience_by_id]
  metadata: [list_interactions, get_interaction_activity, get_interaction_trigger, get_interaction_available_inputs, get_interaction_default_metadata]
  workflow: [list_interactions, get_interaction_workflows, get_interaction_workflow_activities, get_workflow_instance_summary, get_interactions_workflow_status, get_interaction_workflow_instances]
  schedule: [list_interactions, calculate_interaction_next_firing_times]
maxSteps: 15
tags: [rpi, interactions, workflows]
---

# RPI Interactions

Tools for working with **interactions** (RPI's name for campaigns / journeys / activations) and their workflow lifecycle. An interaction has one or more **workflow associations**, each of which can be activated to produce a running **workflow instance**.

Apply foundation guidance: respect `clientId`, look up `parentFolderID` via the folder-listing capability before any create call, show names not IDs.

**`clientId` handling.** Three cases:

1. **No `clientId` provided** (most common — generic requests like "list my interactions") — OMIT the `clientId` argument entirely. The MCP server applies `RPI_DEFAULT_CLIENT_ID` from environment automatically. Do NOT ask the user for a clientId; do NOT refuse to proceed.

2. **`clientId` provided as a UUID** (8-4-4-4-12 hex, e.g. `a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890`) — pass it through unchanged.

3. **`clientId` provided as a non-UUID** (almost certainly a tenant *name* the parent agent forgot to resolve) — your sub-agent's tool filter does NOT include name-resolution. Stop and respond with a clear error asking the parent to redispatch via the **rpi-clients** skill to resolve the name to a UUID. Forwarding a name will fail with a 401 / "Client ID '00000000-0000-0000-0000-000000000000' not found" because RPI parses non-UUID input to the empty UUID.

## Tool inventory

### Discovery
- `list_interactions` — paginated search. Returns card view by default.
- `get_interaction_by_id` — full detail by `id`.
- `get_interaction_by_name` — exact (case-insensitive) name match.

### Interaction internals (read-only)
- `get_interaction_activity` — details for a specific activity within the interaction.
- `get_interaction_trigger` — the trigger configuration (manual, schedule, recurrence, listener, etc.).
- `get_interaction_available_inputs` — input fields available for fulfillment activities.
- `get_interaction_default_metadata` — default metadata for the interaction.

### Workflow discovery
- `get_interaction_workflows` — the workflow associations attached to an interaction. Use this to find a `workflowAssociationId` before activating.
- `get_interaction_workflow_activities` — activities inside a specific workflow association.

### Monitoring
- `get_workflow_instance_summary` — overall summary for a single running/finished instance (needs the integer `workflowAssociationInstanceID`).
- `get_interactions_workflow_status` — current top-level status for one or more interactions (does NOT carry historical execution data).
- `get_interaction_workflow_instances` — list all past and current workflow instances for an interaction id, optionally with their result counts. Use this to answer "what were the counts from the last run?" — pick the most recent terminal-state instance from the returned array.

### Scheduling
- `calculate_interaction_next_firing_times` — compute the next N firing times for a recurrence trigger. Optional `numberOfSchedules` argument.

## Common workflows

### Truncating a long list for display

`list_interactions` returns a bounded preview — **the first 10** (the tool defaults `pageSize` to 10; do **not** set it). The response still reports the total M, so append one line: *"Showing N of M. Filter by name or description substring — e.g., 'list interactions matching MW'."* Never fetch the whole set to "show all" — the top-10 preview is intentional; narrow with a filter to find specific interactions.

> **Read-only skill.** This surface inspects interactions and their workflow runs; it does not start, activate, or control workflows. If the user asks to *run / kick off / pause / stop* an interaction, say that's not available here.

### Interpreting workflow-instance statuses
Instances returned by `get_interaction_workflow_instances` carry a terminal `status`:
- Success: `Completed`, `TestCompleted`, `Deactivated`, `RolledBack`, `Expired`.
- Failure: `Failed`, `TestFailed`, `Stopped`, `Terminated`.

### "Check status of running instance N"
1. `get_workflow_instance_summary` with `workflowAssociationInstanceId` — quick top-line status.
2. If the user wants activity-level detail, `get_interactions_workflow_status`.

### "What were the counts from the last run of interaction X?" (or: existing / prior / last test counts)

The interaction record itself only carries current top-level status (`Not Started`, `In Progress`, etc.) — it does NOT carry historical execution data. To answer this, you must list the interaction's past workflow instances and pick the latest terminal-state one.

1. Resolve `interactionId` (`get_interaction_by_name` or `list_interactions`).
2. `get_interaction_workflow_instances(interactionId, getResultCounts: true)` — pass the interaction's id from step 1 (the file id is fine; the tool resolves the `versionControlID` the endpoint needs via file-info internally). Returns `workflowInstances[]`. Each item is a `WorkflowInfoJsonResponseMessage` with timing, terminal status, and (when `getResultCounts: true`) activity-level result counts.
3. Sort `workflowInstances[]` by completion timestamp and pick the most recent terminal-state one (`Completed`, `TestCompleted`, `Stopped`, `Failed`, etc.). Surface its activity-level counts.

**Common mistakes to avoid:**
- Do NOT call `get_workflow_instance_summary` first — it needs an integer instance ID you don't have yet.
- Do NOT report "Not Started" from `get_interactions_workflow_status` as "the interaction has never run" — that tool reports current top-level state only, not history. If the user asks about *past* runs, always go through `get_interaction_workflow_instances`.
- If `workflowInstances[]` is empty, that genuinely means no execution history exists — say so plainly. (The tool resolves the `versionControlID` internally, so an empty list is a real "never ran," not an id mismatch.)

### Handling multiple matches for an interaction name

`get_interaction_by_name` returns `{found: true, matches: [...]}` — `matches.length` can be 1, or more if multiple interactions share the exact (case-insensitive) name across different folders.

- **1 match:** proceed using `matches[0].id`.
- **2+ matches:** display each with `name` + `fullPath` (the full folder path, e.g. "`Customers_Over_30` at `…\Marketing\Campaigns\Customers_Over_30`" vs "…`\Archive\2024\Customers_Over_30`") and ask the user which one. If `fullPath` is empty, fall back to `parentFolderName`. Never silently pick the first, and never show GUIDs (`id`, `parentFolderID`).
- **0 matches:** fall back to `list_interactions(nameFilter: name)` for fuzzy results before declaring "not found".

### "When will interaction X next run?"
1. Resolve `interactionId`, then `get_interaction_workflows` to find the workflow with a recurrence trigger.
2. `calculate_interaction_next_firing_times` with `workflowAssociationId`. Pass `numberOfSchedules` if the user wants more than the default.
3. Surface times in the user's local terminology (e.g., "next Tuesday at 9 AM" rather than raw ISO).

### "What audience does interaction X use?"

The interaction record and the workflow-activity *tree* do not carry the audience — they only give you the activity's `id`. The audience binding lives on the individual Batch audience activity. Two steps:

1. Resolve `interactionId` (`get_interaction_by_name` or `list_interactions`), then call `get_interaction_by_id` (or `get_interaction_workflows`) and locate the activity with `subTypeName: "Batch audience"` (`typeName: BatchDataflowActivity`). Grab its `id` and the enclosing `workflowAssociationId`.
2. `get_interaction_activity(interactionId, workflowAssociationId, activityId)` → the response carries `dataflowTemplateName` (the audience **name**, use directly) and `dataflowTemplateID` (the audience **GUID**). If you only need the name, stop here — no further call.

If you need richer audience detail, resolve `dataflowTemplateID` via `get_file_info_by_id` (lightweight) or `get_audience_by_id` (full object). Do NOT shortcut by matching the *activity name* against the audience file system — the activity name is editable and is not guaranteed to equal the audience name; `dataflowTemplateID`/`dataflowTemplateName` are the authoritative binding.

### Resolving audience IDs to names

Interaction responses reference an audience by GUID, but the **field name and the tool that exposes it depend on the activity shape** — don't assume a single `audienceID` field.

**Batch audience activity (`BatchDataflowActivity`, subType "Batch audience").** This is the common "the audience used by interaction X" case. You must call **`get_interaction_activity`** (with the activity's `id`) — `get_interaction_workflow_activities` only returns the activity *tree structure* and does NOT carry the audience reference. The `get_interaction_activity` response carries:

- `dataflowTemplateName` — the audience **name**, embedded directly. For just the name, read this and stop; **no follow-up call needed**.
- `dataflowTemplateID` — the audience file **ID** (GUID). Resolve this only when you need more than the name.

Do NOT match the *activity name* against the audience file system to "find" the audience — the activity name is editable and is not guaranteed to equal the audience name. Use `dataflowTemplateID`/`dataflowTemplateName` from `get_interaction_activity`, which are the authoritative binding.

**Other shapes.** Some responses surface the reference as `audienceID`, and a few specialized shapes — notably `InteractiveDataflowActivityAvailableJsonResponseMessage` — carry `audienceName` alongside.

**Pick the right tool by depth of need (once you have the GUID — `dataflowTemplateID`, `audienceID`, etc.):**

1. **Audience name is already on the response.** If a non-empty `dataflowTemplateName` / `audienceName` is present, use it directly. No tool call needed.
2. **You only need the name (or type / folder).** Call `get_file_info_by_id(id: <guid>)`. Returns `{id, name, typeName, subTypeName, parentFolderFullPath}` — lightweight, works for any RPI file type, so the same pattern applies if you encounter a selection-rule ID, channel ID, etc.
3. **You need richer audience-specific detail** (definition, blocks, metadata flags…). Call `get_audience_by_id(audienceId: <guid>)` — returns the full audience object. Use this only when `get_file_info_by_id` doesn't carry the field you need.

Never display a raw GUID to the user.

### "What suppressions does interaction X apply?" (or: exclusions / opt-outs / suppression rules)

Suppressions are an **audience-level** concept — they live in the audience's block graph, not on the interaction. Handle this in two parts:

1. **Name the audience** the interaction uses — resolve it via the Batch audience activity exactly as in "What audience does interaction X use?" above (`get_interaction_activity` → `dataflowTemplateName`/`dataflowTemplateID`). This part you can and should answer directly.
2. **Do NOT enumerate the audience's suppression *rules* from here.** Reading the nested suppression-block detail from the interaction vantage is unreliable — and a confident-but-wrong answer, especially a false "no suppressions are applied," is dangerous on a compliance control. **Never assert which suppression rules exist — or that there are zero — from this skill.** Instead, name the audience and direct the suppression-rule detail to the **audiences** capability, which reads audience internals reliably: e.g. *"Interaction X uses audience 'Advanced Rearranging' — its suppression rules are read via the audiences skill."* Surface the audience name (never a bare GUID); let the audiences skill enumerate the actual rules.

## Response discipline — act, don't punt-loop

When you have what you need to act, act. Two failure modes to avoid:

- **Never re-ask a question you already asked.** If you posed a clarifying question, or the user gave an explicit directive ("list them", "show me", "just do it"), do not loop back and ask the same thing again. Re-asking the same question until `maxSteps` — then giving up — is the failure mode this guidance exists to prevent.
- **Never punt a request you can partly fulfil.** Before replying that something "isn't exposed by a tool," check what you CAN answer by chaining the tools you have — e.g. for a suppressions question you can always **name the audience** the interaction uses (`get_interaction_activity`) even though the rule-level detail belongs to the audiences skill. Answer the part you can, hand off the part you can't, and state any limit plainly — do not close with "let me know how you'd like to proceed."

## Display guidance recap

- Show interaction `name` and the workflow association name (if multiple), not raw IDs.
- For scheduled runs, format times in human language; include timezone if it's not the user's.
- For status, translate to user-friendly: `Completed` ✅, `Failed` ❌, `Stopped` ⛔, etc., when appropriate.
- To name the audience behind a Batch audience activity, call `get_interaction_activity` and read `dataflowTemplateName` (the ID is `dataflowTemplateID`) — not `get_interaction_workflow_activities`, which omits it. For other shapes carrying `audienceID`, prefer the embedded `audienceName` if present; otherwise resolve the GUID via `get_file_info_by_id` (lightweight) — fall back to `get_audience_by_id` only when richer audience detail is needed. Never show a bare audience GUID to the user.
- For questions about *past* / *last* / *existing* interaction counts, always go through `get_interaction_workflow_instances` — never read `status` off the interaction record itself (that's a current-state field, not history).
