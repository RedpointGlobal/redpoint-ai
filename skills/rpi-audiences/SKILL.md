---
name: rpi-audiences
title: RPI Audiences
description: Operational playbook for the RPI MCP server's audience tools — list/get/metadata, audience definitions, and the test-workflow lifecycle (activate → poll status → fetch results).
type: action
mcpToolFilter:
  - list_audiences
  - get_audience_by_id
  - get_audience_by_name
  - get_audience_metadata
  - list_audience_definitions
  - get_audience_definition_by_id
  - get_audience_definition_by_name
  - run_audience_test_workflow
  - get_audience_workflow_activity_status
  - get_audience_workflow_block_results
  - get_audience_workflow_results
  - list_audience_test_instances
  - get_audience_execution_results
operations:
  list: [list_audiences]
  get: [list_audiences, get_audience_by_id, get_audience_by_name]
  metadata: [list_audiences, get_audience_metadata]
  definitions: [list_audiences, list_audience_definitions, get_audience_definition_by_id, get_audience_definition_by_name]
  workflow: [list_audiences, run_audience_test_workflow, get_audience_workflow_activity_status, get_audience_workflow_block_results, get_audience_workflow_results, list_audience_test_instances, get_audience_execution_results]
maxSteps: 15
tags: [rpi, audiences, workflows]
---

# RPI Audiences

Tools for working with **audience files** (the actual segmented record sets) and **audience definitions** (the data-structure templates audiences are built from). Two distinct concepts — keep them straight:

- **Audience** = a specific audience file (the user's "Q1 winback list"). Identified by an audience `id`.
- **Audience Definition** = a template that defines the data structure / fields an audience uses. Identified by a definition `id` or `name`. Required when creating new audiences.

Apply foundation guidance: respect `clientId`, look up `parentFolderID` via the folder-listing capability before any create call, show names not IDs.

**`clientId` handling.** Three cases:

1. **No `clientId` provided** (most common — generic requests like "list my audiences") — OMIT the `clientId` argument entirely. The MCP server applies `RPI_DEFAULT_CLIENT_ID` from environment automatically. Do NOT ask the user for a clientId; do NOT refuse to proceed.

2. **`clientId` provided as a UUID** (8-4-4-4-12 hex, e.g. `a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890`) — pass it through unchanged.

3. **`clientId` provided as a non-UUID** (almost certainly a tenant *name* the parent agent forgot to resolve) — your sub-agent's tool filter does NOT include name-resolution. Stop and respond with a clear error asking the parent to redispatch via the **rpi-clients** skill to resolve the name to a UUID. Forwarding a name will fail with a 401 / "Client ID '00000000-0000-0000-0000-000000000000' not found" because RPI parses non-UUID input to the empty UUID.

## Tool inventory

### Discovery
- `list_audiences` — paginated search across audience files. Optional `nameFilter`, `folderId`. Default returns card view (`id`, `name`, `description`, `parentFolderName`).
- `get_audience_by_id` — full detail by audience `id`.
- `get_audience_by_name` — exact (case-insensitive) name match. Returns `{found: true, matches: [...]}` (always an array; 2+ when the same name exists in multiple folders). See "Handling multiple matches" below. Chain to `get_audience_by_id` with a match's `id` for full detail.
- `get_audience_metadata` — schema/metadata for an audience by `id`.

### Audience definitions (templates)
- `list_audience_definitions` — list available templates. Configuration endpoint, no pagination.
- `get_audience_definition_by_id` — full template detail.
- `get_audience_definition_by_name` — exact name match.

### Test-workflow lifecycle (3 steps)
- `run_audience_test_workflow` — kick off a test execution of the audience workflow. Returns a `workflowAssociationInstanceID` you'll need for the next steps.
- `get_audience_workflow_activity_status` — poll for status by `workflowAssociationInstanceID`.
- `get_audience_workflow_block_results` — per-block **runtime counts** after a test run (how many records each block — filters, splits, suppression blocks — processed). NOTE: these are execution *counts*, NOT the audience's configured suppression **rules**. For the configured suppressions themselves, inspect `get_audience_by_id(verbose: true)` → `initialProcessBlocks[]` (suppression blocks carry `$jsonType: "BlockSuppressionsJsonResponseMessage"` and a `suppressions[]` array).
- `get_audience_workflow_results` — final aggregated results.

### Test instance history & results
- `list_audience_test_instances` — historical test runs for an audience.
- `get_audience_execution_results` — execution results for a specific run.

## Common workflows

### Truncating a long list for display

`list_audiences` returns a bounded preview — **the first 10** (the tool defaults `pageSize` to 10; do **not** set it). The response still reports the total M, so append one line: *"Showing N of M. Filter by name or description substring — e.g., 'list audiences matching MW'."* Never fetch the whole library to "show all" — the top-10 preview is intentional; narrow with a filter to find specific audiences.

### "Find an audience by name and show its details"
1. `get_audience_by_name` (or `list_audiences` with `nameFilter` if user wants to browse).
2. Take the `id` from `matches[0]` (see "Handling multiple matches" if `matches.length > 1`).
3. `get_audience_by_id` with that `id` for full detail.
4. If the user asks about field structure, `get_audience_metadata`.

### Handling multiple matches for an audience name

`get_audience_by_name` returns `{found: true, matches: [...]}` — `matches.length` can be 1, or more if multiple audiences share the exact (case-insensitive) name across different folders.

- **1 match:** proceed using `matches[0].id`.
- **2+ matches:** display each with `name` + `fullPath` (the full folder path, e.g. "`MA Residents` at `Users\vdelguercio\Active\MA Residents`" vs "…`\Archive\2024\MA Residents`") and ask the user which one. If `fullPath` is empty, fall back to `parentFolderName`. Never silently pick the first, and never show GUIDs (`id`, `parentFolderID`) — they're for chaining/context only.
- **0 matches:** fall back to `list_audiences(nameFilter: name)` for fuzzy results before declaring "not found".

### "Run a test of audience X and show me the counts"
This is the canonical 3-step lifecycle. The audience workflow runs asynchronously; you must poll until it terminates.

1. Resolve audience `id` (use `get_audience_by_name` or `list_audiences` if the user gave you a name).
2. Call `run_audience_test_workflow` with the `id`. The tool blocks on a default 220-second timeout polling internally — you don't usually need to call the status tool yourself unless the user wants intermediate updates or the run exceeds the timeout. The return value contains the `workflowAssociationInstanceID`.
3. If the run completed inside `run_audience_test_workflow`, jump straight to fetching results:
   - `get_audience_workflow_block_results` for per-block **counts** (filters, splits, suppression blocks) — counts only; for the configured suppression *rules*, see `get_audience_by_id`.
   - `get_audience_workflow_results` for the final aggregated output.
   - **`activityId` for these counts calls = the `workflowAssociationID`** (returned by `run_audience_test_workflow` alongside `workflowAssociationInstanceID`). This is an RPI quirk — the counts endpoints key `ActivityID` to the workflowAssociationID, not a separate activity GUID. Passing an empty or unrelated value fails with "ActivityID is required". `run_audience_test_workflow` already handles this internally; only supply it yourself when calling the standalone counts tools.
4. If `run_audience_test_workflow` timed out (status was still `Playing` at timeout), use `get_audience_workflow_activity_status` with the `workflowAssociationInstanceID` to check current state. Statuses: `NotStarted`, `Playing`, `Completed`, `Failed`, `Stopped`.
5. Surface results to the user with the per-block counts. Don't dump full payloads — summarize.

If the workflow failed, the status response will indicate the failure; share that with the user and suggest checking the audience configuration.

### "List recent test runs for audience X"
1. Resolve audience `id`.
2. `list_audience_test_instances` with the `id`.
3. For a specific run, `get_audience_execution_results` with the test instance ID.

### "What audience definitions are available for creating a new audience?"
1. `list_audience_definitions` — short, no pagination.
2. Show names and descriptions; capture the chosen one's `id` for the eventual create call. (Audience creation itself is not yet exposed by this MCP server — if the user wants to create an audience, surface that limitation.)

## Definitions vs files — common confusion

Users (and the LLM) often conflate these:
- "What audiences are there?" → `list_audiences` (files).
- "What audience definitions are there?" → `list_audience_definitions` (templates).
- "How is the audience set up?" / "What fields does it have?" → `get_audience_metadata` on the audience file, OR `get_audience_definition_by_id` on its underlying template.

When the user says "audience X uses what schema?" — get the audience first (`get_audience_by_id`), find the definition reference, then `get_audience_definition_by_id`.

## `verbose` and pagination defaults

- All `list_*` tools default to `verbose: false` and a card view. Pass `verbose: true` only if the user wants raw payloads.
- `pageSize` defaults to **10** (the standard list view) — do **not** set it, even when the user says "all audiences". To narrow, use a `nameFilter` / description substring rather than raising `pageSize`. The list is intentionally a top-10 preview.

## Do not reflexively pass `nameFilter` when the user's noun is a CONCEPT, not a NAME

`list_audiences` accepts a `nameFilter` substring. Use it ONLY when the user explicitly references a specific audience name they want to find.

- ✅ "show me the audience named '1103 – MA Residents'" → `nameFilter: "1103 – MA Residents"`
- ✅ "find audiences starting with '2024'" → `nameFilter: "2024"`
- ❌ "list my audiences" → NO filter (user's word "audiences" is the OBJECT class, not a name fragment)
- ❌ "audiences with counts > 0" → NO filter (the noun is a concept; the predicate is on counts, not names)
- ❌ "show me my segments" → NO filter (synonym for audiences/selection-rules, still a concept)

The discipline: ask yourself *"is the user pointing at a specific record's name, or naming the object class they want listed?"* Reflexively passing the class noun as a filter substring is a routing-class bug — it silently returns a wrong (empty / wrong-records) slice and the user sees a confidently wrong answer. Default to NO `nameFilter` for any discovery prompt; only opt in when the user gives you actual name material.

## Operational notes

- **Don't show `id` (or any GUID) to users by default.** The card view already includes `name` and `parentFolderName`. Use `id` for chaining only.
- **Disambiguate** duplicate names with `parentFolderName` — `get_audience_by_name` returns all same-name matches in `matches[]`; never silently pick the first when there's more than one.
- **The default 220-second timeout** on `run_audience_test_workflow` is bounded by the MCP transport, not by caution: the transport aborts the call at ~240s, so a larger `timeoutSeconds` cannot actually buy more time and the run dies mid-flight instead of returning a clean timeout. Treat ~220s as the working ceiling and tell the user a long workflow needs to be checked with the status tool rather than waited on. The tool polls every 1 second internally; you don't need to call the status tool manually unless you want to surface intermediate progress.

## Response discipline

These rules are LOAD-BEARING for response correctness. Violating any produces user-visible incorrect behavior (the kind that masquerades as a working answer). All source-pinned.

### COUNTS are not handled here — redirect to rpi-selection-rules

For COUNT requests on audiences ("how many records in audience X", "audiences with counts > N", "list audiences with counts > 0"), counts are owned by the sister skill **rpi-selection-rules**. Do NOT attempt counts here. Return a redirect message so the parent agent can re-dispatch — e.g., *"This count question is served by the rpi-selection-rules skill. Please redispatch with that skill."* Your sub-agent has no `execute_skill`; the redirect is a return-message the parent ToolLoopAgent acts on.

### Do not assert filter criteria you did not verify

If the user asks to filter by a property the list tool does NOT return, you MUST either (a) chain to follow-on tools that provide that property and filter from that data, or (b) explicitly tell the user "I can list the items but the data doesn't include X — would you like me to fetch X for each?" DO NOT claim filter compliance you didn't verify. Never label an unfiltered list as filtered.

### On clear directives, execute — don't ask "would you like to proceed?"

When the user's prompt is a clear directive ("do X", "return Y", "show me Z"), EXECUTE the workflow chain — don't pause to ask "would you like to proceed?" Only ask permission when intent is genuinely ambiguous (e.g., destructive write, multi-tenant scope unclear, or you'd need to pick between materially-different chains). Bounded by skill `maxSteps`.

Concrete example: *"run a test workflow on audience X"* is a directive — call `run_audience_test_workflow` directly, then poll status, then surface results. Don't stop to ask "should I proceed with the test run?" A prompt like *"show me JB stuff"* is genuinely ambiguous — that one warrants a clarifying question. Default toward execution; ask only when the chain itself is unclear.
