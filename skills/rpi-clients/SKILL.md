---
name: rpi-clients
title: RPI Clients (Tenants)
description: The CLUSTER-WIDE / all-tenants (admin) client directory — listing or looking up EVERY Client provisioned on the cluster, by ID or name. A "Client" in RPI is a tenant / customer-facing workspace; every other RPI operation runs in the context of a Client (carried via the X-ClientID header). Use ONLY for explicit all-tenants / cluster-wide phrasing ("all clients", "every tenant", "list all clients on the cluster") — a cluster-admin view that requires cluster permissions. For the clients the CURRENT caller can access ("my clients", "list my clients", "which clients can I access?"), use rpi-admin (get_user_client_list), which is user-scoped.
type: action
mcpToolFilter:
  - list_clients
  - get_client_by_id
  - get_client_by_name
maxSteps: 5
tags: [rpi, clients, tenants]
---

# RPI Clients (Tenants)

Tools for inspecting the **Clients** provisioned on this RPI cluster. In RPI vocabulary a *Client* is a tenant — a customer-facing workspace that owns its own audiences, interactions, selection rules, folder tree, configuration, and audit history. Every other RPI operation flows through one Client at a time, identified by `X-ClientID`.

## Identity is the UUID, presentation is the name

Every downstream RPI tool (rpi-audiences, rpi-interactions, rpi-selection-rules, rpi-folders, rpi-admin) accepts `clientId` as a **UUID**. When you call `list_clients`, `get_client_by_id`, or `get_client_by_name`, the response always contains both `id` (UUID) and `name` (friendly display string). **Always retain the `id` in working memory** so subsequent tool calls in the same conversation can pass it through. Display preference is a separate concern — show `name` to the user for readability — but the UUID is the identity that downstream tools require. **Never pass a Client name where a `clientId` is expected; the call will fail.**

## Tool inventory

- `list_clients` — return all Clients (tenants) provisioned on this RPI cluster. Read-only, no required args.
- `get_client_by_id` — fetch a single Client by its UUID.
- `get_client_by_name` — fetch a single Client by its exact (case-insensitive) display name.

## How a Client maps to other operations

Every audience / interaction / selection-rule / folder / report call carries a `clientId` argument (or implicitly the configured default). That `clientId` IS the Client UUID returned by these tools. So this skill is effectively the *entry point* for any operation:

- User wants to work with audiences in tenant "Acme" → first resolve Acme's `id` (UUID) via `get_client_by_name`, then any sibling skill (rpi-audiences, rpi-interactions, etc.) uses that **UUID** as `clientId` downstream.
- User asks "what tenants do we have?" → `list_clients` and present the names. UUIDs are not displayed unless the user asks, but they remain in your working memory for any follow-up.

## Common workflows

### "List my clients" / "what tenants are there?"

1. `list_clients` with no args.
2. **Always include the `id` (UUID) alongside the `name` in your response.** The parent agent uses this UUID as `clientId` for every downstream skill call (rpi-audiences, rpi-interactions, etc.); once your sub-agent returns, the parent cannot recover the UUID later. Format as `Name (id: <uuid>)` or list `id` as a separate field — either is fine — but do not omit it. Optional secondary fields: `description`, `isActive`, `createdAt`. **Never substitute the name for the UUID** when handing off.
3. If the list is long, group or sort by name.

### "Find the Acme tenant" / "what's the ID of client X?"

1. `get_client_by_name` with the user-stated name.
2. **Always include the returned `id` (UUID) in your response** alongside the `name` and optional `description`. The parent agent passes this UUID as `clientId` to subsequent skill calls; once your sub-agent returns, the parent cannot recover it. Format as `Name (id: <uuid>)` or list `id` as a separate field. Same rule whether or not the user explicitly asked for the UUID.
3. If not found, fall back to `list_clients` and offer near-name matches.

### Setup / handoff to another skill

Any time the user says "in tenant Acme, …" or "for client Acme, list audiences," resolve the Client first:

1. `get_client_by_name` → grab the `id` (UUID). **This UUID is what gets passed to sibling skills as `clientId`. Do NOT pass the Client name.**
2. Hand off to the appropriate sibling skill (rpi-audiences, rpi-interactions, etc.) with that UUID as `clientId`.
3. Don't bother re-resolving the same name within a single conversation — once you have the UUID, reuse it for every subsequent call.

### Default tenant behavior

If the parent's request does not name a specific Client (e.g., "find the clientId", "what's my tenant"), respond that the MCP server applies `RPI_DEFAULT_CLIENT_ID` from environment automatically and the parent should redispatch the original action skill without a clientId. Only call `list_clients` if the user explicitly asks "what tenants exist?" / "list my clients". **Never ask the user to pick a tenant** — use the env default.

## Display guidance recap

- **Always emit the UUID in your response back to the parent agent.** This skill is invoked via sub-agent dispatch (`execute_skill`); your response is the only thing the parent sees, so anything you don't render is lost forever. The parent decides downstream presentation — your job is to surface the identity (`id`) plus the friendly label (`name`), every time.
- Show `isActive: false` distinctly — these are tenants but inactive ones generally shouldn't be operated on.
- For "list clients" output, sort by name; the cluster is rarely large enough to need pagination at this layer.
