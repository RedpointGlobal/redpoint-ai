---
name: rpi-folders
title: RPI Files & Folders
description: Files and folders in an RPI tenant — the browsable folder tree and a folder's contents, folder access permissions, the caller's private folder, plus file-system reads for any stored file (metadata, change history, forward and reverse dependencies), the file-info attribute-list catalog, and external-folder storage connectors. The file-system organization layer over audiences, interactions, rules, and content. Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - list_folders
  - get_folder_by_full_path
  - list_folder_content
  - get_user_private_folder
  - get_folder_permissions
  - get_folder_permissions_by_full_path
  - get_file_metadata
  - get_file_history
  - list_file_info_attribute_lists
  - get_file_dependencies
  - get_file_dependents
  - search_external_folder_connectors
operations:
  folder: [list_folders, get_folder_by_full_path, list_folder_content, get_user_private_folder]
  folder-permissions: [get_folder_permissions, get_folder_permissions_by_full_path]
  file-info: [get_file_metadata, get_file_history, list_file_info_attribute_lists]
  file-dependencies: [get_file_dependencies, get_file_dependents]
  connectors: [search_external_folder_connectors]
maxSteps: 5
tags: [rpi, folders, files, filesystem]
---

# RPI Files & Folders

Tools for the RPI tenant's **file-system layer** — the folder tree that organizes
every other object (audiences, interactions, rules, content), and the file-system
reads (metadata, history, dependencies) for the stored files inside it.

Apply foundation guidance: respect `clientId`, show names not IDs.

## Folder tools (operation `folder`)

- `list_folders` — walk the entire folder TREE (root + recursive subfolders), a flat
  list of nodes. Optional case-insensitive `nameFilter`. Cached per (user, client)
  for 5 minutes. This is the browse-the-whole-tree entry point.
- `list_folder_content` — the CONTENTS directly inside ONE folder (by id): its files
  and immediate subfolders. Distinct from `list_folders` (the whole tree).
- `get_folder_by_full_path` — one folder's own properties by its full path string
  (e.g. `\Audiences\MW\`). Folders read by PATH only — there is no folder-by-id read;
  resolve a folder's path by browsing `list_folders`.
- `get_user_private_folder` — the authenticated caller's private (home) folder. No id.

### How `list_folders` returns the tree

By default (`verbose: false`), each node has:

```json
{ "id": "...", "name": "...", "fullPath": "Parent\\Child\\Leaf\\", "parentFolderId": "..." | null }
```

- `fullPath` is the most useful field for users — a backslash-delimited path like
  `RPIWeb\Audiences\My Folder\`. `parentFolderId` is `null` for root folders.
- **Do not** rely on the `parentFolderID` field of raw RPI responses (it's always the
  all-zero UUID — a known RPI quirk). Trust what `list_folders` reconstructs.
- For raw RPI records pass `verbose: true` (bypasses the cache; empty parent fields as
  RPI returns them).

## Folder permissions (operation `folder-permissions`)

- `get_folder_permissions` — the access permissions on a folder by its **id** (which
  users/groups can see/use it).
- `get_folder_permissions_by_full_path` — the same, keyed by full **path**.

## File-system reads (operation `file-info`)

For a stored file of ANY type (audience, interaction, rule, offer, …), keyed by file id:

- `get_file_metadata` — the file-system properties (metadata ABOUT the file). NOT the
  file's content — fetch content via the domain skill (e.g. rpi-audiences,
  rpi-content). NOT the name/type/folder card.
- `get_file_history` — the change/version trail of a stored file.
- `list_file_info_attribute_lists` — the attribute-list catalog available in the
  file-info context (e.g. selectable as file-info display columns). No id. This is the
  FILE-SYSTEM sense of "attribute lists" — see disambiguation below.

## File dependencies (operation `file-dependencies`)

- `get_file_dependencies` — what a file (by id) depends ON: its own inputs/references
  (outgoing / forward).
- `get_file_dependents` — what depends ON a file (by id): what references it and would
  be affected if it changed (incoming / reverse; `IncludeLooseDependencies` for
  indirect). The two are opposite directions — pick by which way the user is asking.

## External connectors (operation `connectors`)

- `search_external_folder_connectors` — the storage connectors (cloud / SFTP endpoints)
  that back EXTERNAL folders, by name or id. Storage infrastructure, distinct from the
  internal browsable folder tree above.

## Common workflows

### "List the folders" / "what folders are there?"
1. `list_folders` with no args → show `name` or `fullPath`.
2. To find one, `list_folders` with `nameFilter`; disambiguate duplicates by `fullPath`.

### "What's inside folder X?" vs "what folders exist?"
- Inside ONE folder → `list_folder_content` (needs the folder id).
- The whole tree → `list_folders`.

## Disambiguation (what this skill is NOT)

- **`list_file_info_attribute_lists` is NOT the tenant attribute lists.** The
  reusable attribute lists across the tenant are the **rpi-attributes** skill; this
  tool is only the file-info display-column catalog. Route "my attribute lists" to
  rpi-attributes; route "file-info / display-column attribute lists" here.
- **File METADATA, not file CONTENT.** `get_file_metadata` is the file-system record;
  the actual object content lives in its domain skill (rpi-audiences, rpi-content,
  rpi-decision-rules, …).
- **Not the objects themselves** — this skill is the file-system organization layer;
  the audiences / interactions / rules / content it organizes are their own skills.

> **Read-only skill.** Lists and inspects folders and file-system records; creates,
> moves, and deletes nothing. If the user asks to create/move a folder or file, say
> that's not available here.
