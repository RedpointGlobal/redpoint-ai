---
name: rpi-attributes
title: RPI Attributes & Reference Lists
description: Reusable attribute definitions and reference lists in an RPI tenant — covers "list my attribute lists", "what attributes are in list X", "show cached attributes", "managed basic lists", "value lists / pick-lists", and the enumerated values of a value list. These are the reusable building blocks that selection rules, audiences, and interactions reference. Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - list_attribute_lists
  - get_attribute_list
  - get_attribute_list_by_name
  - list_cached_attributes
  - get_cached_attributes
  - get_cached_attributes_by_name
  - list_managed_basic_lists
  - get_managed_basic_list
  - get_managed_basic_list_by_name
  - list_value_lists
  - get_attribute_value_list
operations:
  attribute-lists: [list_attribute_lists, get_attribute_list, get_attribute_list_by_name]
  cached-attributes: [list_cached_attributes, get_cached_attributes, get_cached_attributes_by_name]
  managed-basic-lists: [list_managed_basic_lists, get_managed_basic_list, get_managed_basic_list_by_name]
  values: [list_value_lists, get_attribute_value_list]
maxSteps: 5
tags: [rpi, attributes, reference-lists, value-lists]
---

# RPI Attributes & Reference Lists

Tools for the reusable attribute and reference-list building blocks in an RPI
tenant. These are **definitions**, not customer data — selection rules, audiences,
and interactions *reference* them, but this skill only lists and inspects them.

Apply foundation guidance: respect `clientId`, show names not IDs.

## The four object types (don't blur them)

- **Attribute list** — a reusable named *set of client-data attributes*, referenced
  by selection rules and audiences. `list_attribute_lists` / `get_attribute_list`
  (by id) / `get_attribute_list_by_name`.
- **Cached attributes** — the cached/materialized attribute layer (precomputed
  attribute values for performance). `list_cached_attributes` /
  `get_cached_attributes` (by id) / `get_cached_attributes_by_name`.
- **Managed basic list** — the value set behind a **Basic** selection rule.
  `list_managed_basic_lists` / `get_managed_basic_list` (by id) /
  `get_managed_basic_list_by_name`.
- **Value list** — an enumerated pick-list (allowed values). `list_value_lists` to
  browse; `get_attribute_value_list` returns the enumerated **values** of one (by id,
  `ForceRefresh` to bypass any cache).

## Operations (menu-narrowing)

Split by OBJECT TYPE — each op is the list + both getters (by id, by name) for one
type, so every menu stays small:

- **attribute-lists** — the reusable attribute lists (`list_attribute_lists`,
  `get_attribute_list`, `get_attribute_list_by_name`).
- **cached-attributes** — the materialized attribute layer (`list_cached_attributes`,
  `get_cached_attributes`, `get_cached_attributes_by_name`).
- **managed-basic-lists** — the value sets behind Basic selection rules
  (`list_managed_basic_lists`, `get_managed_basic_list`, `get_managed_basic_list_by_name`).
- **values** — value lists and their enumerated values (`list_value_lists`,
  `get_attribute_value_list`).

If the router passes no operation, the full inventory is available (safe fallback).

## Common workflows

### "List my attribute lists"
1. `list_attribute_lists` (no args) → show `name` + `description`.
2. For a name lookup, `get_attribute_list_by_name`; by id, `get_attribute_list`.

### "What values does list X allow?"
1. `list_value_lists` to find the list id (by name).
2. `get_attribute_value_list` with that id → the enumerated values.

### "Show the cached attributes" / "managed basic list for rule Y"
1. Use the matching `list_*` to find the id, then the `get_*` (by id or name).

## Disambiguation (what this skill is NOT)

- **Not the selection rules / audiences that USE these** — those are `rpi-selection-rules`
  and `rpi-audiences`. This skill is the reusable *definitions* they reference.
- **Not file-info attribute-lists** — the file-system's per-file attribute-list read
  is a different, file-scoped list handled elsewhere; it is not part of this skill.
- Attribute **list** (a set of attributes) ≠ value **list** (an enumeration of allowed
  values) ≠ cached attributes (the materialized layer). Name each precisely to the user.

> **Read-only skill.** Lists and inspects reference definitions; creates/edits nothing.
