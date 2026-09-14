---
name: rpi-users-permissions
title: RPI Users & Permissions
description: Client-tenant user administration in RPI — the users configured in this tenant, their group memberships, the user groups themselves, and per-user permissions plus the catalog of assignable permissions. Scope is the CLIENT's directory of users and their access — NOT the current caller's own auth identity (that is rpi-admin) and NOT cluster-level users that span clients (that is rpi-cluster). Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - list_users
  - get_user_details
  - list_user_groups
  - get_user_group
  - get_user_group_by_name
  - get_user_permissions
  - list_available_permissions
operations:
  users: [list_users, get_user_details]
  groups: [list_user_groups, get_user_group, get_user_group_by_name]
  permissions: [get_user_permissions, list_available_permissions]
maxSteps: 5
tags: [rpi, users, permissions, groups, administration]
---

# RPI Users & Permissions

Read-only administration of the **client tenant's users, groups, and permissions** —
the directory of who is configured in this client and what access they hold.

## Scope — read this first (three "user" surfaces, keep them apart)

RPI has three different notions of "user"; this skill owns exactly ONE:

- **THIS skill — the CLIENT's users.** The tenant's user directory: who exists,
  their groups, their permissions. "List the users", "what groups is X in", "what
  permissions does Y have".
- **NOT the caller.** The *current authenticated caller's* own identity, profile,
  client list, and recent items are the **rpi-admin** skill. "Who am I", "my
  profile", "my clients", "my recent items" → rpi-admin, not here.
- **NOT cluster users.** Cluster-level users that span clients (and external users)
  are the **rpi-cluster** skill. "Cluster users", "external users" → rpi-cluster.

If a prompt is about the *caller themselves* or about *cluster* users, this skill is
the wrong home — say so rather than answering from the client directory.

Apply foundation guidance: respect `clientId`, show names not IDs.

## Tool inventory & operations

- **users** — `list_users` (the tenant's configured users, id + name) and
  `get_user_details` (one client user's config, including group memberships;
  `OnlyActiveGroups=true` to limit to active groups).
- **groups** — `list_user_groups` (all groups; groups bundle users for permission
  assignment), `get_user_group` (one group by id, with members),
  `get_user_group_by_name` (same record by exact name).
- **permissions** — `get_user_permissions` (what one named user actually has) vs
  `list_available_permissions` (the full catalog of permissions that CAN be
  assigned). Name-the-user question → `get_user_permissions`; "what permissions
  exist / can be granted" → `list_available_permissions`.

Missing/unknown operation falls back to the full inventory (safe).

## Common workflows

- **"List the users"** → `list_users` (no args). Show names, not ids.
- **"What groups is user X in?"** → `get_user_details` for that user (group
  memberships are on the details record).
- **"What can user X do?"** → `get_user_permissions` (by user name).
- **"What permissions can we grant?"** → `list_available_permissions` (the catalog).

## Disambiguation (what this skill is NOT)

- **Not the caller's identity** — the caller's own profile, client list, and
  recent items are the **rpi-admin** skill. This skill never answers "who am I".
- **Not cluster users** — cluster users and external users are the **rpi-cluster**
  skill.
- **Not folder permissions** — access on a *folder* is the rpi-folders skill;
  this skill's permissions are the *user's* assigned permissions.

> **Read-only skill.** Inspects the user/group/permission directory; changes nothing.
