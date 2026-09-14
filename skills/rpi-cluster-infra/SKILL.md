---
name: rpi-cluster-infra
title: RPI Cluster Infrastructure
description: Cluster-level platform inventory in RPI — the cluster-wide system tasks, a client's auxiliary databases, and the plugins installed on the cluster. Scope is CLUSTER platform inventory — NOT cluster USERS (that is rpi-cluster-users), NOT the health, error-log, and audit diagnostics surface (that is rpi-admin), and NOT client-scoped operations (that is rpi-operations). Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_cluster_system_tasks
  - get_cluster_client_auxiliary_databases
  - list_cluster_plugins
maxSteps: 5
tags: [rpi, cluster, infrastructure, plugins]
---

# RPI Cluster Infrastructure

Read-only reads of **cluster-level platform inventory** — the cluster's scheduled
system tasks, a client's auxiliary databases, and the plugins installed on the
cluster. A small, magnet-free menu: three distinct nouns, so tool selection is
deterministic even without an operation hint.

## Scope — read this first

- **THIS skill — cluster PLATFORM inventory.** Cluster-wide system tasks, a client's
  auxiliary databases, and installed cluster plugins.
- **NOT cluster users.** The cluster user directory (internal + external users) is the
  **rpi-cluster-users** skill.
- **NOT diagnostics or logs.** Cluster health, the API error log, and audit history
  are the **rpi-admin** skill. (The cluster's general error/housekeeping logs are not
  surfaced by any skill — they remain direct-API only. This skill is deliberately
  log-free so a platform prompt can't be pulled to a log read.)
- **NOT client operations.** Client-scoped audit/SQL-audit/housekeeping/system-tasks/
  jobs are the **rpi-operations** skill; this skill's tasks are CLUSTER-scoped.

Apply foundation guidance: respect `clientId`, show names not IDs.

## Tool inventory

- `get_cluster_system_tasks` — the cluster's cluster-wide background/scheduled jobs
  and their state (paged).
- `get_cluster_client_auxiliary_databases` — a client's auxiliary databases (its
  secondary data sources beyond the primary), keyed by the client id.
- `list_cluster_plugins` — the plugins/extensions installed on the cluster.

Three tools, one coherent menu — no operation sub-groups needed.

## Disambiguation (what this skill is NOT)

- **Not cluster users** — the cluster user directory is **rpi-cluster-users**.
- **Not cluster diagnostics/logs** — health, the API error log, and audit history are
  **rpi-admin**; the cluster's general/housekeeping logs are direct-API only and
  deliberately not in this skill's menu.
- **Not client operations** — client-scoped audit/tasks/jobs are **rpi-operations**.

> **Read-only skill.** Inspects cluster platform inventory; changes nothing.
