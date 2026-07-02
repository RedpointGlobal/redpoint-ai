---
name: rpi-folders
title: RPI Folders
description: Folder hierarchy in an RPI tenant — covers "what folders exist", "list my folders", "where is X organized", "folder tree", and creating new folders. Folders organize audiences, interactions, and selection rules in a tree.
type: action
mcpToolFilter:
  - list_folders
  - create_folder
maxSteps: 5
tags: [rpi, folders, filesystem]
---

# RPI Folders

Tools for working with the RPI tenant's folder hierarchy. Folders organize all the other objects (audiences, interactions, selection rules) into a tree.

Apply foundation guidance: respect `clientId`, show names not IDs.

**`clientId` handling.** Three cases:

1. **No `clientId` provided** (most common — generic requests like "list my folders") — OMIT the `clientId` argument entirely. The MCP server applies `RPI_DEFAULT_CLIENT_ID` from environment automatically. Do NOT ask the user for a clientId; do NOT refuse to proceed.

2. **`clientId` provided as a UUID** (8-4-4-4-12 hex, e.g. `e0633f26-9843-4def-b394-6791ac51e6de`) — pass it through unchanged.

3. **`clientId` provided as a non-UUID** (almost certainly a tenant *name* the parent agent forgot to resolve) — your sub-agent's tool filter does NOT include name-resolution. Stop and respond with a clear error asking the parent to redispatch via the **rpi-clients** skill to resolve the name to a UUID. Forwarding a name will fail with a 401 / "Client ID '00000000-0000-0000-0000-000000000000' not found" because RPI parses non-UUID input to the empty UUID.

## Tool inventory

- `list_folders` — walk the entire folder tree (root + recursive subfolders) and return a flat list of nodes. Optional case-insensitive substring `nameFilter`. Cached in-memory per (user, client) for 5 minutes; subsequent calls within that window are instant.
- `create_folder` — create a folder. Requires `name`. Optional `description`, `parentFolderId` (omit for root), `clientId`. Invalidates the user's cached folder tree on success.

## How `list_folders` returns the tree

By default (`verbose: false`), each node has:

```json
{ "id": "...", "name": "...", "fullPath": "Parent\\Child\\Leaf\\", "parentFolderId": "..." | null }
```

- `fullPath` is the most useful field for users — it's a backslash-delimited path like `RPIWeb\Audiences\My Folder\`.
- `parentFolderId` is reconstructed by the MCP server during the walk. **Do not** rely on the `parentFolderID` field of raw RPI responses (it's always the all-zero UUID and an empty string for `parentFolderName` / `parentFolderFullPath` — a known RPI quirk). Trust what `list_folders` gives you.
- `parentFolderId` is `null` for root folders.

If the user wants raw RPI records, pass `verbose: true` (returns the full `FolderStorageItemJsonResponseMessage` shape, with the empty parent fields as RPI returns them).

## Common workflows

### "List the folders" or "what folders are there?"
1. `list_folders` with no args.
2. Show `name` (or `fullPath` to give context). Sort or group as fits the user's request.
3. If the user said "find the Audiences folder," try `list_folders` with `nameFilter: "audience"` for a narrower result.

### "What's the ID of folder X?" (preparation for a create call)
1. `list_folders` with `nameFilter` containing a distinctive part of the name.
2. If multiple match, disambiguate with `fullPath`. The user may need to clarify which one they meant.
3. Return the matched node's `id` to whatever workflow needs it (typically as `parentFolderId` on a create call elsewhere).

You usually do this implicitly inside another workflow ("create an audience in folder X" → first you list folders, then call create with the resolved ID).

### "Create a folder called X under Y"
1. Resolve parent folder ID:
   - User said a name → `list_folders` with `nameFilter`, pick the right match.
   - User said "at the root" → no parent, omit `parentFolderId`.
2. `create_folder` with `name`, optional `description`, and the resolved `parentFolderId`.
3. The tool returns `{id: "<new-folder-id>"}`. Confirm to the user with the new folder's name and where it was created.
4. The cache is invalidated automatically — a follow-up `list_folders` will see the new folder.

### "Create a folder at the root"
Same as above without the `parentFolderId`. The new folder appears at the top of the tree.

## Caching behavior

- `list_folders` caches the walked tree per (user, client) for 5 minutes.
- The cache is bypassed when `verbose: true` (raw responses are not cached).
- `create_folder` invalidates the user's cache on success — the next `list_folders` will refetch.
- The `nameFilter` is applied **after** cache read, so successive filtered calls all hit the cache.

If you suspect stale data (someone else created a folder out-of-band), pass `verbose: true` once to force a fresh read, or just wait for the 5-minute TTL.

## Display guidance recap

- Prefer `fullPath` when showing folders to users — it gives context.
- For tree-style display, sort by `fullPath` and you'll get a sensible hierarchical order.
- Use `name` alone only when the path context is already established ("here are folders under Audiences:").
