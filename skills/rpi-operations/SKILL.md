---
name: rpi-operations
title: RPI Operations & Jobs
description: Client-scoped operational diagnostics for an RPI tenant — covers "show my audit history", "SQL audit log", "housekeeping / maintenance-job logs", "system tasks", "execution services", and async "job status / job log". CLIENT-scoped operational reporting (distinct from cluster-level health, which is rpi-admin). Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_operation_audit_history
  - get_operation_sql_audit_history
  - get_operation_housekeeping_logs
  - list_operation_system_tasks
  - list_execution_services
  - get_job_status
  - get_job_log
operations:
  logs: [get_operation_audit_history, get_operation_sql_audit_history, get_operation_housekeeping_logs]
  tasks: [list_operation_system_tasks]
  services: [list_execution_services]
  jobs: [get_job_status, get_job_log]
maxSteps: 5
tags: [rpi, operations, logs, jobs, diagnostics]
---

# RPI Operations & Jobs

Client-scoped operational reads for an RPI tenant — the audit trail, maintenance
logs, system tasks, execution services, and async job status/log. All **CLIENT/
tenant-scoped**: the cluster-wide equivalents (cluster health, cluster API error
log, cluster audit history) belong to **rpi-admin**, not here.

Apply foundation guidance: respect `clientId`, show names not IDs.

## Tool inventory

**Logs** (paged via `PageNumber` / `PageSize`):
- `get_operation_audit_history` — the client's change/action audit trail.
- `get_operation_sql_audit_history` — audited SQL statements executed for the client.
- `get_operation_housekeeping_logs` — maintenance/cleanup-job logs.

**Tasks & services:**
- `list_operation_system_tasks` — background/scheduled jobs scoped to the client.
- `list_execution_services` — the client's compute/execution endpoints and status.

**Async jobs** (by job `ID`, paged):
- `get_job_status` — current state/progress of a job.
- `get_job_log` — a job's log output.

## Operations (menu-narrowing)

- **logs** — audit / SQL-audit / housekeeping.
- **tasks** — system tasks.
- **services** — execution services.
- **jobs** — job status + log.

Missing/unknown operation falls back to the full inventory (safe).

## Common workflows

### "Show my audit history" / "any recent SQL run?"
1. `get_operation_audit_history` (general) or `get_operation_sql_audit_history`
   (SQL-specific). Paged — start at page 1, page on request.

### "What's the status of job X?" / "show its log"
1. `get_job_status` with the job `ID`. For the run output, `get_job_log`.

### "What execution services are available?"
1. `list_execution_services` (no args).

## Disambiguation (what this skill is NOT)

- **Not cluster-level diagnostics** — cluster health, the cluster API error log, and
  the cluster audit history are **rpi-admin**. This skill is CLIENT-scoped
  operational reporting: "my audit history" here, "the cluster's" there.
- **Not workflow-run telemetry** — activity results/logs/traces for an interaction
  workflow are a separate concern; this skill is tenant-level ops logs + async jobs.

> **Read-only skill.** Reports operational state; changes nothing.
