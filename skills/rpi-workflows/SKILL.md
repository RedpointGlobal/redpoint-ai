---
name: rpi-workflows
title: RPI Workflow Runs & Telemetry
description: Workflow-run execution telemetry in an RPI tenant — per-activity results, logs, assets, and SQL traces for a workflow-association instance, instance-level results/summaries, run logs, audience-block results, and run-config reads. The runtime diagnostics of a workflow RUN (keyed by WorkflowAssociationInstanceID), distinct from the interaction objects themselves (rpi-interactions). Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_workflow_activity_results
  - get_workflow_activity_log
  - get_workflow_activity_assets
  - get_workflow_activity_sql_trace
  - get_workflow_all_activity_results
  - list_workflow_instance_summaries
  - get_workflow_association_instance_logs
  - get_workflow_audience_block_instance_results
  - get_decision_offer_test_channel_fulfillment_states
  - get_data_process_default_parameters
operations:
  activity: [get_workflow_activity_results, get_workflow_activity_log, get_workflow_activity_assets, get_workflow_activity_sql_trace]
  instance: [get_workflow_all_activity_results, list_workflow_instance_summaries]
  logs: [get_workflow_association_instance_logs]
  audience-block: [get_workflow_audience_block_instance_results]
  run-config: [get_decision_offer_test_channel_fulfillment_states, get_data_process_default_parameters]
maxSteps: 5
tags: [rpi, workflows, telemetry, runs]
---

# RPI Workflow Runs & Telemetry

Read-only reads for the **execution telemetry of a workflow run** — the per-activity
and instance-level results, logs, assets, and traces of a specific
workflow-association instance. This is the RUN diagnostics; the interaction objects
and their workflow status/config live in `rpi-interactions`.

Apply foundation guidance: respect `clientId`, show names not IDs.

## Keys & sub-groups

A run is a **WorkflowAssociationInstanceID**; an **ActivityID** is a step within it.

- **activity** — ONE activity of a run (WorkflowAssociationInstanceID + ActivityID),
  by artifact: `get_workflow_activity_results` / `_log` / `_assets` / `_sql_trace`.
- **instance** — the whole run: `get_workflow_all_activity_results` (all activities)
  and `list_workflow_instance_summaries` (per-activity summaries).
- **logs** — `get_workflow_association_instance_logs`, the run-level log across the
  whole workflow-association instance (by WorkflowAssociationInstanceID — the same
  run key the rest of this skill uses).
- **audience-block** — `get_workflow_audience_block_instance_results` (ONE audience
  block instance's results, by ActivityID + WorkflowAssociationInstanceID +
  BlockInstanceID). For ALL blocks of an activity, that's the rpi-audiences skill.
- **run-config** — `get_decision_offer_test_channel_fulfillment_states` (a
  decision-offer's test channel states) and `get_data_process_default_parameters`
  (a data-process activity's default params, by InteractionID +
  WorkflowAssociationID + DataProcessActivityID).

Getters need the run/activity ids above — supply them; there is no list-all-runs tool
here (find a run via the interaction's workflow status in rpi-interactions).

## Operations (menu-narrowing)

`activity` · `instance` · `logs` · `audience-block` · `run-config` — each a ≤5-tool
menu. Missing/unknown operation falls back to the full inventory (safe).

## Disambiguation (what this skill is NOT)

- **Not the interaction objects** — `rpi-interactions` owns interactions and their
  workflow STATUS/config/next-firing ("list my interactions", "what's the status of
  interaction X's workflow", "when does it fire"). This skill owns the RUN telemetry
  (results/logs/traces of a specific run instance). Interaction-centric run questions
  ("my welcome interaction's last run") start at rpi-interactions; a specific run's
  activity telemetry (by WorkflowAssociationInstanceID) is here.
- **Not audiences** — the all-blocks audience-workflow results reader is the
  rpi-audiences skill; this skill's block reader is the single-block-by-id variant.

> **Read-only skill.** Inspects run telemetry; changes nothing.
