---
name: rpi-admin
title: RPI Admin & Health
description: Connectivity, authentication, and health diagnostics — covers "am I logged in?", "am I authenticated to RPI?", "is the MCP server online?", "is the connection working?", cluster health/alerts, API error log, audit history. Use for ANY question about whether the integration, auth, or backend is functioning. Read-only; no user-data writes.
type: action
mcpToolFilter:
  - get_system_health_availability
  - get_cluster_api_error_log
  - get_cluster_audit_history
  - verify_connection
maxSteps: 5
tags: [rpi, admin, health, diagnostics]
---

# RPI Admin & Health

Read-only diagnostics for the RPI cluster — health, errors, audit, and connection sanity. Use these when the user is asking about *the system itself* rather than the data inside a tenant. None of these tools write state.

Apply foundation guidance: respect `clientId` where applicable, surface raw error strings unmodified.

**`clientId` handling.** Three cases:

1. **No `clientId` provided** (most common — generic requests like "list my audiences") — OMIT the `clientId` argument entirely. The MCP server applies `RPI_DEFAULT_CLIENT_ID` from environment automatically. Do NOT ask the user for a clientId; do NOT refuse to proceed.

2. **`clientId` provided as a UUID** (8-4-4-4-12 hex, e.g. `e0633f26-9843-4def-b394-6791ac51e6de`) — pass it through unchanged.

3. **`clientId` provided as a non-UUID** (almost certainly a tenant *name* the parent agent forgot to resolve) — your sub-agent's tool filter does NOT include name-resolution. Stop and respond with a clear error asking the parent to redispatch via the **rpi-clients** skill to resolve the name to a UUID. Forwarding a name will fail with a 401 / "Client ID '00000000-0000-0000-0000-000000000000' not found" because RPI parses non-UUID input to the empty UUID.

## Tool inventory

- `get_system_health_availability` — point-in-time health probe across the cluster's services. Returns per-service availability and any active alerts.
- `get_cluster_api_error_log` — recent error log entries from the RPI API service. Useful when something has been failing and the user wants to see why.
- `get_cluster_audit_history` — change/audit trail across the cluster. Who did what, when, on which entity.
- `verify_connection` — auth + connectivity sanity check. Confirms the MCP server can reach RPI and that auth is working. Returns OIDC config (if any), proxy-token status, login settings, and an `/info/version` probe.

## When to use which

| User asks | Tool |
|---|---|
| "Is the system up?" / "any alerts?" | `get_system_health_availability` |
| "Show me recent errors" / "what's been failing?" | `get_cluster_api_error_log` |
| "Who changed X?" / "audit trail for tenant Y" | `get_cluster_audit_history` |
| "Verify the connection" / "is auth working?" | `verify_connection` |

## Common workflows

### "Is the system healthy?"

1. `get_system_health_availability` with no args.
2. Show the overall status + any individual services that are down or degraded. Surface alert messages verbatim — they're often actionable.
3. If everything is green, say so concisely. Don't pad.

### "Show me recent errors"

1. `get_cluster_api_error_log`. Apply any time-range or severity filter the user asked for.
2. Present each entry with its timestamp, severity, source service, and message. Group by service if the list is long.
3. If the user is investigating a specific failure, suggest running `verify_connection` afterward to confirm connectivity is still working.

### "What changed in tenant X?"

1. `get_cluster_audit_history` scoped to the user's tenant via `clientId` (resolve via rpi-clients first if the user named the tenant by name).
2. Filter by entity-type or actor as the user requests.
3. Each entry has actor + timestamp + action + entity reference. Present chronologically (newest first or oldest first as the user asked).

### "Verify the connection"

1. `verify_connection`.
2. Surface the bundle: OIDC issuer (if any), proxy-token validity, login settings, `/info/version` probe success.
3. If anything failed, surface the error string verbatim. The OIDC / auth-failure messages are diagnostic-grade — don't paraphrase.

## Display guidance recap

- Health output: green = "all services available," red/yellow = name the affected service.
- Error log: show the most recent first; truncate stack traces only if the user explicitly wants brief output.
- Audit: chronological order; include actor identity (user/service account/system).
- Connection-verify: structured key/value rendering of the result; don't reformat field names.
