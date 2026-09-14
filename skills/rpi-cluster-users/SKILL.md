---
name: rpi-cluster-users
title: RPI Cluster Users
description: Cluster-level user directory in RPI — the accounts defined at the CLUSTER, spanning all clients, both internal RPI-managed users and federated/external (SSO) identities, each with their accessible-client lists and a named user's profile. Scope is CLUSTER users — NOT one client's own user directory (that is rpi-users-permissions), NOT the current caller's own identity (that is rpi-admin), and NOT cluster infrastructure like logs/tasks/plugins (that is rpi-cluster-infra). Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - list_cluster_users
  - get_cluster_user
  - get_cluster_user_by_name
  - get_cluster_user_clients
  - get_cluster_user_profile
  - list_cluster_external_users
  - get_cluster_external_user
  - get_cluster_external_user_clients
operations:
  internal-users: [list_cluster_users, get_cluster_user, get_cluster_user_by_name, get_cluster_user_clients, get_cluster_user_profile]
  external-users: [list_cluster_external_users, get_cluster_external_user, get_cluster_external_user_clients]
maxSteps: 5
tags: [rpi, cluster, users, administration]
---

# RPI Cluster Users

Read-only reads of the **cluster-level user directory** — accounts defined at the
cluster, spanning every client. Two kinds: internal RPI-managed accounts and
federated/external (SSO) identities.

## Scope — read this first (four surfaces, keep them apart)

- **THIS skill — CLUSTER users.** Accounts at the cluster level, internal and
  external, their accessible-client lists, and a named cluster user's profile.
- **NOT one client's users.** A single client/tenant's own user directory, groups,
  and permissions are the **rpi-users-permissions** skill.
- **NOT the caller.** The current authenticated caller's own identity/profile is the
  **rpi-admin** skill. A profile here is some *named* cluster user's, never "who am I".
- **NOT cluster infrastructure.** Cluster logs, system tasks, auxiliary databases,
  and plugins are the **rpi-cluster-infra** skill — not this one.

Apply foundation guidance: respect `clientId`, show names not IDs.

## Tool inventory & operations

- **internal-users** — internal cluster accounts: `list_cluster_users`,
  `get_cluster_user` (by id) / `get_cluster_user_by_name`, `get_cluster_user_clients`
  (the clients that user can reach), `get_cluster_user_profile` (a NAMED user's
  cluster profile — not the caller's).
- **external-users** — federated/SSO cluster identities (distinct from the internal
  accounts): `list_cluster_external_users`, `get_cluster_external_user` (by id),
  `get_cluster_external_user_clients` (that external user's reachable clients).

Missing/unknown operation falls back to the full 8-tool inventory (all
cluster-user reads — a small, coherent menu).

## Internal vs external

Every read has an internal and an external variant — pick by whether the user is an
internal RPI account or a federated/SSO identity. If the prompt doesn't say, default
to the internal `list_cluster_users` / `get_cluster_user` and note the external
variant exists.

## Disambiguation (what this skill is NOT)

- **Not client users** — a single client's directory is **rpi-users-permissions**.
- **Not the caller** — "who am I" / the caller's profile is **rpi-admin**.
- **Not cluster infrastructure** — logs, tasks, aux databases, and plugins are
  **rpi-cluster-infra**.

> **Read-only skill.** Inspects the cluster user directory; changes nothing.
