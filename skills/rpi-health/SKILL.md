---
name: rpi-health
title: RPI System Health
description: RPI SYSTEM-health status — "is the system up?", "any alerts?", "is RPI healthy?", service availability, and the aggregate health-monitoring overview. Point-in-time availability across the cluster's services + active alerts, plus the client's monitoring view. This is SYSTEM HEALTH only. (For connectivity/auth sanity — "is my connection working?", "am I logged in?", "is my token valid?" — use the rpi-admin skill's connection check, which does NOT probe system health. For the cluster error/audit logs use rpi-admin diagnostics.) Read-only; no writes.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_system_health_availability
  - get_system_health_monitoring_overview
operations:
  availability: [get_system_health_availability]
  overview: [get_system_health_monitoring_overview]
maxSteps: 5
tags: [rpi, health, monitoring]
---

# RPI System Health

Read-only checks of whether the RPI **system** is up and healthy — service
availability and the aggregate monitoring overview. Use these for "is the system
up?", "any alerts?", "is RPI healthy?", "overall health".

**This is distinct from a CONNECTION check.** "Is my connection working / am I
logged in / is my token valid" is the rpi-admin skill's connection check — a plain
connection check must NOT pull a system-health probe. This skill owns system
health; rpi-admin owns connectivity, identity, and diagnostics.

Apply foundation guidance: respect `clientId` where applicable, surface raw error strings unmodified.

## Tools

- `get_system_health_availability` — point-in-time availability probe across the cluster's services + active alerts. **Cluster-admin scoped**: a non-admin caller gets a graceful "not available for your role"; that's expected.
- `get_system_health_monitoring_overview` — the client's aggregate system-health monitoring view (`RunCheckNow` to force a fresh check). User-scoped (client-level). Distinct from the cluster availability probe above.

## When to use which

| User asks | Tool |
|---|---|
| "Is the system up?" / "any alerts?" / "is RPI healthy?" | `get_system_health_availability` |
| "Overall system-health overview" / "monitoring overview" | `get_system_health_monitoring_overview` |

## Common workflow — "Is the system healthy?"

1. `get_system_health_availability` with no args.
2. Show the overall status + any individual services that are down or degraded. Surface alert messages verbatim — they're often actionable.
3. If everything is green, say so concisely. Don't pad.

## Display guidance

- Green = "all services available"; red/yellow = name the affected service.
- On the cluster availability probe a non-admin caller may get "not available for your role" — expected; the client monitoring overview is user-scoped.
