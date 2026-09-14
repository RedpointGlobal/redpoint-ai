---
name: rpi-databases
title: RPI Databases & Data Model
description: The data layer of an RPI tenant — client databases and their schema catalogs, match/join keys, SQL database definitions, table joins, resolution levels, seed definitions, and column mappings. Covers "list my databases", "what tables/columns are in database X", "show the match keys", "SQL database definitions", "table joins", "resolution levels", "seed definitions". These are the data structures selection rules and audiences are built ON. Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - list_databases
  - get_database
  - get_database_catalog
  - list_database_keys
  - get_database_key
  - get_database_key_by_name
  - list_sql_database_definitions
  - list_sql_database_definitions_summary
  - get_sql_database_definition
  - get_sql_database_definition_by_name
  - get_sql_database_definition_available_criterion
  - list_table_joins
  - get_table_join_simple
  - get_table_join_simple_by_name
  - get_table_join_multiple
  - get_table_join_multiple_by_name
  - list_resolution_levels
  - get_resolution_level
  - get_resolution_level_by_name
  - list_seed_definitions
  - get_seed_definition
  - search_column_mappings
operations:
  databases: [list_databases, get_database, get_database_catalog]
  keys: [list_database_keys, get_database_key, get_database_key_by_name]
  sql-defs: [list_sql_database_definitions, list_sql_database_definitions_summary, get_sql_database_definition, get_sql_database_definition_by_name, get_sql_database_definition_available_criterion]
  table-joins: [list_table_joins, get_table_join_simple, get_table_join_simple_by_name, get_table_join_multiple, get_table_join_multiple_by_name]
  resolution: [list_resolution_levels, get_resolution_level, get_resolution_level_by_name]
  seeds: [list_seed_definitions, get_seed_definition]
  column-mappings: [search_column_mappings]
maxSteps: 5
tags: [rpi, databases, data-model, sql, table-joins]
---

# RPI Databases & Data Model

Read-only reads for the **data layer** of an RPI tenant — the databases, their
schema/keys, and the data-model definitions (SQL definitions, table joins,
resolution levels, seeds, column mappings) that selection rules and audiences are
built ON. This skill inspects the *structures*; the rules/audiences that query them
are `rpi-selection-rules` / `rpi-audiences`.

Apply foundation guidance: respect `clientId`, show names not IDs.

## Operations (this skill is broad — pick the operation to narrow the menu)

Each operation exposes a ≤5-tool menu. Pass the one matching the request:

- **databases** — the databases themselves + schema catalog (`list_databases`,
  `get_database`, `get_database_catalog`).
- **keys** — a database's match/join keys (`list_database_keys`,
  `get_database_key`, `get_database_key_by_name`).
- **sql-defs** — SQL database definitions (`list_sql_database_definitions`,
  `list_sql_database_definitions_summary`, `get_sql_database_definition`,
  `get_sql_database_definition_by_name`, `get_sql_database_definition_available_criterion`).
- **table-joins** — join definitions: `simple` (single-key) vs `multiple`
  (composite), each by id/name, plus `list_table_joins`.
- **resolution** — resolution levels / grain (`list_resolution_levels`,
  `get_resolution_level`, `get_resolution_level_by_name`).
- **seeds** — seed definitions (`list_seed_definitions`, `get_seed_definition`).
- **column-mappings** — `search_column_mappings`.

Missing/unknown operation falls back to the full 22-tool inventory (safe).

## Tool inventory (by group)

**Databases** — `list_databases` (all client databases), `get_database` (one by id —
its config), `get_database_catalog` (its schema: tables/columns).

**Keys** — `list_database_keys`, `get_database_key` (by id), `get_database_key_by_name`
— the match/join keys defined on a database.

**SQL database definitions** — `list_sql_database_definitions` (full),
`list_sql_database_definitions_summary` (id+name index), `get_sql_database_definition`
(by id), `get_sql_database_definition_by_name`, and
`get_sql_database_definition_available_criterion` (the fields a definition can be
queried on).

**Table joins** — `list_table_joins`; `get_table_join_simple` / `_by_name`
(single-key joins) vs `get_table_join_multiple` / `_by_name` (composite / multi-key
joins). Pick simple vs multiple by whether the join has one key or several.

**Resolution levels** — `list_resolution_levels`, `get_resolution_level` (by id),
`get_resolution_level_by_name` — the entity grain (e.g. person / household).

**Seed definitions** — `list_seed_definitions`, `get_seed_definition`.

**Column mappings** — `search_column_mappings` (find column-mapping definitions).

## Common workflows

- **"List my databases"** → `list_databases`. For schema, `get_database_catalog`.
- **"What are the match keys for database X?"** → `list_database_keys` (find by name
  with `get_database_key_by_name`).
- **"Show my table joins"** → `list_table_joins`; fetch one with the simple/multiple
  getter depending on its key count.
- **"What resolution levels exist?"** → `list_resolution_levels`.

## Disambiguation (what this skill is NOT)

- **Not the selection rules / audiences that QUERY these** — those own segment/
  audience logic (`rpi-selection-rules`, `rpi-audiences`). This skill is the data
  *structures* underneath.
- **Not attribute lists / value lists** — those reusable attribute definitions are
  `rpi-attributes`. Here it's databases, keys, SQL defs, joins, resolution, seeds.

> **Read-only skill.** Inspects the data model; changes nothing.
