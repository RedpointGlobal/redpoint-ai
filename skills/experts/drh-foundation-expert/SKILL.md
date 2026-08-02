---
name: drh-foundation-expert
title: Data Readiness Hub Foundation
description: Cross-cutting essentials for every Data Readiness Hub MCP tool call — client/tenant ID, database scoping, ID typing, read/error conventions, terminology. Loaded into every Data Readiness Hub conversation.
type: expert
maxSteps: 5
tags: [drh, foundation, mcp]
---

# Data Readiness Hub Foundation

You have access to Redpoint Data Readiness Hub via an MCP server (`drh-mcp-server`) that exposes tools across databases, sources, feeds, runs, data quality, subject areas, and schedules. Tools are namespaced as `drh__<tool_name>`. Discover the actual tools available at runtime via the connected MCP server.

This guidance applies to **every** Data Readiness Hub tool call. Read it once; apply it everywhere.

## Everything is scoped to a database

Data Readiness Hub organizes work by **database**, and a deployment operates on a single configured database. That database is applied **automatically** as the default scope on every database-scoped call — you do **not** supply, resolve, or ask for a database id. Just act; the tool layer fills it in.

- Only pass a database id when the user explicitly names a *different* database to work in.
- A few catalog-wide reads (listing all databases, subject areas) are not database-scoped.

## Client (tenant) selection

Every Data Readiness Hub call is scoped to a single tenant via the `X-ClientId` HTTP header. The MCP server has a default tenant (`DRH_DEFAULT_CLIENT_ID`); tools accept an optional client-id argument that overrides the default for one call.

- If the user hasn't specified a tenant, use the default — don't pass a client id.
- Never invent a client id; an empty value means "use the default."

## Identifier typing

Data Readiness Hub identifiers are numeric or string, consistently by entity:
- **Numeric** — database, source, feed, feed-run / match-run / rpi-sync-run, data-quality.
- **String** — subject-area, schedule, aggs-schedule, job, automation.

Pass ids in the correct type; never fabricate one — resolve it from a listing first.

## Reads & responses

- For dashboard-style questions ("how is this database doing", readiness, run history), prefer the richer database-scoped summary views over raw per-record reads — they return pre-aggregated answers in one call.
- Some column / export reads return raw CSV text rather than JSON; relay it as-is.

## Errors

Relay tool errors plainly. A `403` means the account isn't permitted for that specific endpoint (a permissions/provisioning matter, not a malformed request). A `400` usually means a required scope — commonly a database id — was missing; supply it and retry.

## Terminology — what users say vs. what Data Readiness Hub calls things

- "data source" / "source" → a **source** within a database.
- "feed" → a **feed** (a source's processed output); one execution of it is a **feed-run**.
- "readiness" / "data health" → the database / CDP **summary** metrics (e.g. successful-run rate) and **data-quality** signals (hygiene scores, match confidence).
- "matching" → **match-runs**; "sync to RPI" → **rpi-sync-runs**.
- "schedule" → a **schedule** (v3); aggregation schedules are **aggs schedules**.
- "subject area" → a **subject area** (a string-id'd data grouping).
