---
name: drh-schedules
title: Data Readiness Hub Schedules
description: Data Readiness Hub schedules & automation — covers "list schedules", "show schedule X", "when does this schedule next run", aggregation schedules, and automation-log history. Read-only reporting on live Data Readiness Hub schedules via the Data Readiness Hub MCP server.
type: action
mcpToolFilter:
  - drh_list_schedules
  - drh_get_schedule
  - drh_get_schedule_by_job
  - drh_calculate_schedule_times
  - drh_list_aggs_schedules
  - drh_get_aggs_schedule
  - drh_list_aggs_job_templates
  - drh_search_automation_logs
  - drh_get_automation_log
operations:
  list:
    - drh_list_schedules
    - drh_list_aggs_schedules
    - drh_search_automation_logs
  get:
    - drh_get_schedule
    - drh_get_schedule_by_job
    - drh_get_aggs_schedule
    - drh_get_automation_log
  calculate:
    - drh_calculate_schedule_times
maxSteps: 5
tags: [drh, schedules, automation, data-readiness]
---

# Data Readiness Hub Schedules

Handle **read** operations on **Data Readiness Hub schedules, aggregation schedules, and automation logs**:
listing schedules, fetching one by id or job, calculating a schedule's upcoming run times, and
reading automation-log history. Use the connected Data Readiness Hub tools to answer with real data — do not
describe concepts here (that is the `drh-domain-expert`'s job); this skill *acts*.

Schedules are **scoped to a database**, and the deployment's database is applied automatically — you
don't supply, resolve, or ask for one. Just act; pass an id only when the user names a specific
schedule, job, or aggregation schedule.

- **List** schedules, aggregation schedules, or automation logs when the user asks what's scheduled
  or to see recent automation activity.
- **Get** a single schedule (by id or job), aggregation schedule, or automation-log entry when named.
- **Calculate** a schedule's upcoming run times when the user asks when something next runs.

Relay the tool's response back clearly. This skill is **read-only** — it reports schedules and
history, it does **not** create, edit, pause, resume, restart, or delete schedules. Requests to
*change* scheduling are not handled here (a later, gated operation covers that). Conceptual
questions about scheduling belong to the Data Readiness Hub domain expert.
