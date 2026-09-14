---
name: rpi-admin
title: RPI Admin, Identity & Diagnostics
description: Connectivity, authentication, the authenticated CALLER's own identity, and cluster diagnostics/audit — covers "am I logged in?", "who am I / my profile", "which clients can I access? / my clients / list my clients" (the tenants the CALLER can reach — get_user_client_list, user-scoped, works per-user), "my recent items", "is my token valid?", "is the connection working?", login settings, the cluster API error log, and the CLUSTER/system-wide audit history. The skill for questions about ME (the caller) and about connectivity/diagnostics. (For SYSTEM HEALTH — "is the system up?", "any alerts?", "is RPI healthy?" — use rpi-health. For the CLUSTER-WIDE list of ALL tenants — "all clients", "every tenant" — use rpi-clients. For a CLIENT/tenant's own audit trail — "my audit history" — use rpi-operations. For a specific CLIENT's user directory use rpi-users-permissions; for CLUSTER-level users use rpi-cluster.) Read-only; no user-data writes.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_user_profile
  - get_user_client_list
  - get_user_recent_items
  - verify_connection
  - validate_token_status
  - get_login_settings
  - get_cluster_api_error_log
  - get_cluster_audit_history
operations:
  # verify_connection is a member of EVERY operation on purpose: it is the
  # low-privilege, per-user, can't-403 connectivity/auth probe (/info/version),
  # so whether a user can check their connection MUST NOT depend on the router
  # guessing operation="auth". If it's dispatched under any other operation,
  # verify_connection is still in the sub-agent's toolset — deterministic,
  # not a phrase allowlist. (2026-08-17: operation="diagnostics" had hidden it,
  # sending a plain connection check to the cluster-admin error log → 403.)
  identity: [get_user_profile, get_user_client_list, get_user_recent_items, verify_connection]
  auth: [verify_connection, validate_token_status, get_login_settings]
  diagnostics: [get_cluster_api_error_log, get_cluster_audit_history, verify_connection]
maxSteps: 5
tags: [rpi, admin, identity, diagnostics]
---

# RPI Admin, Identity & Diagnostics

Read-only reads about **the caller (ME)** and **connectivity/diagnostics** — who the
current credentials are, what they can reach, whether auth/connectivity work, and the
cluster error/audit trail. Use these when the user asks about *themselves as the
caller* or about *connectivity/diagnostics*, not the data inside a tenant. Nothing
writes state. (SYSTEM HEALTH — "is the system up?" — is a separate skill: **rpi-health**.
This skill has no health tool.)

## Scope — the CALLER, not a named user (three "user" surfaces)

This skill owns the **authenticated caller's own** identity — "who am I", "my profile",
"which clients can I access", "my recent items". That is distinct from the other two
"user" surfaces:

- **THIS skill — the CALLER.** `get_user_profile` is *my* identity for the token
  making the call. Never a lookup of some other named user.
- **NOT a client's users.** A specific named user in a client's directory (their
  details, groups, permissions) is the **rpi-users-permissions** skill.
- **NOT cluster users.** A named cluster-level user's profile is the **rpi-cluster**
  skill.

Apply foundation guidance: respect `clientId` where applicable, surface raw error strings unmodified.

## Tool inventory & operations

### identity — the caller (ME)
- `get_user_profile` — *my* RPI profile: display name, username, email, roles/permissions for the token making the call. "Who am I / what am I authorized to do."
- `get_user_client_list` — the clients (tenants) *I* can access, id + name. Use to discover valid `X-ClientID` values before scoping a call. (This is MY reachable clients — the full tenant list is the **rpi-clients** skill.)
- `get_user_recent_items` — *my* recently-accessed files/objects (caller-scoped convenience list).

### auth — connectivity & sign-in
- `verify_connection` — auth + connectivity sanity check. Confirms the MCP server can reach RPI and auth works. Returns OIDC config, proxy-token status, login settings, and an `/info/version` probe.
- `validate_token_status` — lightweight liveness check on *my* access token (active / expired / revoked). Use before a longer sequence of calls.
- `get_login_settings` — the tenant's login/authentication settings — the configured identity provider (OpenID/Keycloak) and login options.

### diagnostics — errors & cluster audit
- `get_cluster_api_error_log` — recent error log entries from the RPI API service. (The cluster's GENERAL error log and housekeeping log are the **rpi-cluster** skill.)
- `get_cluster_audit_history` — the CLUSTER/system-wide change/audit trail. For a single CLIENT/tenant's own audit history ("my audit history"), that's the **rpi-operations** skill, not here.

## When to use which

| User asks | Tool |
|---|---|
| "Who am I?" / "my profile" / "what am I authorized to do?" | `get_user_profile` |
| "Which clients can I access?" / "my clients" | `get_user_client_list` |
| "My recent items" | `get_user_recent_items` |
| "Verify the connection" / "is auth working?" | `verify_connection` |
| "Is my token still valid?" | `validate_token_status` |
| "How is sign-in / the IdP configured?" | `get_login_settings` |
| "Show me recent errors" / "what's been failing?" | `get_cluster_api_error_log` |
| "cluster/system-wide audit" / "who changed what across the cluster" | `get_cluster_audit_history` |
| "Is the system up?" / "any alerts?" / "is RPI healthy?" | → use the **rpi-health** skill |

## Common workflows

### "Show me recent errors"

1. `get_cluster_api_error_log`. Apply any time-range or severity filter the user asked for.
2. Present each entry with its timestamp, severity, source service, and message. Group by service if the list is long.
3. If the user is investigating a specific failure, suggest running `verify_connection` afterward to confirm connectivity is still working.

### "What changed across the cluster?" (cluster/system-wide audit)

1. `get_cluster_audit_history` — the cluster-wide change trail. (A CLIENT/tenant's own "my audit history" is the **rpi-operations** skill, not this.)
2. Filter by entity-type or actor as the user requests.
3. Each entry has actor + timestamp + action + entity reference. Present chronologically (newest first or oldest first as the user asked).

### "Verify the connection" / "check my connection" / "am I connected?"

1. `verify_connection` — and **ONLY** this tool. It already covers auth + connectivity (OIDC, proxy-token status, login settings, `/info/version`).
2. A connection check is NOT a system-health check. This skill has no health tool by design; "is the system up?" / "any alerts?" is the **rpi-health** skill — a separate, explicit request. Don't reach for health on a plain connection check.
3. Surface the bundle: OIDC issuer (if any), proxy-token validity, login settings, `/info/version` probe success.
4. If anything failed, surface the error string verbatim. The OIDC / auth-failure messages are diagnostic-grade — don't paraphrase.

## Display guidance recap

- Error log: show the most recent first; truncate stack traces only if the user explicitly wants brief output.
- Audit: chronological order; include actor identity (user/service account/system).
- Connection-verify: structured key/value rendering of the result; don't reformat field names.
