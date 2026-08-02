---
name: drh-runs
title: Data Readiness Hub Runs
description: Data Readiness Hub runs — covers "list feed runs", "show me the last match run", "record metrics for this run", "when is the match-run schedule", RPI sync runs, and per-database run summaries. Read-only reporting on live Data Readiness Hub runs via the Data Readiness Hub MCP server.
type: action
mcpToolFilter:
  - drh_list_feed_runs
  - drh_get_feed_run_by_id
  - drh_get_feed_run_record_metrics
  - drh_search_feed_runs
  - drh_get_match_run_by_id
  - drh_get_match_run_schedule
  - drh_get_rpi_sync_run_by_id
  - drh_list_database_match_runs
  - drh_list_database_rpi_sync_runs
operations:
  list:
    - drh_list_feed_runs
    - drh_list_database_match_runs
    - drh_list_database_rpi_sync_runs
  get:
    - drh_get_feed_run_by_id
    - drh_get_match_run_by_id
    - drh_get_rpi_sync_run_by_id
  metrics:
    - drh_get_feed_run_record_metrics
    - drh_search_feed_runs
    - drh_get_match_run_schedule
maxSteps: 5
tags: [drh, runs, matching, data-readiness]
---

# Data Readiness Hub Runs

Handle **read** operations on **Data Readiness Hub runs** — feed runs, match runs, and RPI sync runs: listing
runs, fetching one by id, reporting a feed run's record metrics, and reading the match-run schedule.
Use the connected Data Readiness Hub tools to answer with real data — do not describe concepts here (that is the
`drh-domain-expert`'s job); this skill *acts*.

Runs are **scoped to a database** (feed runs additionally to a feed), and the deployment's database
is applied automatically — you don't supply, resolve, or ask for one. A feed run listing needs the
feed the user is asking about; pass ids only when the user names them.

- **List** feed / match / RPI-sync runs when the user asks to see runs or run history.
- **Get** a single run by id when the user names or ids one.
- **Metrics** — report a feed run's record metrics or the match-run schedule when asked about
  volumes, outcomes, or timing.

Relay the tool's response back clearly. This skill is **read-only** — it reports on runs, it does
**not** start, create, pause, resume, or force-run anything. Requests to *trigger* a run are not
handled here (a later, gated operation covers that). Conceptual questions about what a run is belong
to the Data Readiness Hub domain expert.
