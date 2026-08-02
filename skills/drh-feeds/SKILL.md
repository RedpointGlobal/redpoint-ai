---
name: drh-feeds
title: Data Readiness Hub Feeds
description: Data Readiness Hub feeds — covers "list my feeds", "show feed X", "what columns / match fields does this feed have", "feed versions", and per-database feed summaries. Read-only reporting on live Data Readiness Hub feeds via the Data Readiness Hub MCP server.
type: action
mcpToolFilter:
  - drh_list_feeds
  - drh_get_feed_by_id
  - drh_get_feed_columns
  - drh_get_feed_metadata
  - drh_get_feed_version
  - drh_list_feed_versions
  - drh_list_feed_match_fields
  - drh_list_deleted_feeds
  - drh_check_feed_name_availability
  - drh_list_database_feeds
  - drh_get_database_feed
  - drh_get_database_feed_version
  - drh_get_database_feeds_summary
  - drh_list_database_feeds_page
operations:
  list:
    - drh_list_feeds
    - drh_list_database_feeds
    - drh_list_database_feeds_page
  get:
    - drh_get_feed_by_id
    - drh_get_database_feed
    - drh_get_feed_metadata
    - drh_get_database_feeds_summary
  versions:
    - drh_list_feed_versions
    - drh_get_feed_version
    - drh_get_database_feed_version
  columns:
    - drh_get_feed_columns
    - drh_list_feed_match_fields
maxSteps: 5
tags: [drh, feeds, data-readiness]
---

# Data Readiness Hub Feeds

Handle **read** operations on **Data Readiness Hub feeds**: listing feeds, fetching one by id, and reporting a
feed's columns, match fields, metadata, and version history — plus the per-database feed summary.
Use the connected Data Readiness Hub tools to answer with real data — do not describe concepts here (that is the
`drh-domain-expert`'s job); this skill *acts*.

Feeds are **scoped to a database**, and the deployment's database is applied automatically — you
don't supply, resolve, or ask for one. Just act; only pass a database or source id if the user
explicitly names a different one.

- **List** the feeds when the user asks what feeds exist / to see them.
- **Get** a single feed, its metadata, or a database's feed summary when the user names or ids one.
- **Versions** — report a feed's version history or a specific version when asked.
- **Columns** — report a feed's columns or match fields when asked about its schema/mapping.

Relay the tool's response back clearly. This skill is **read-only** — it reports, it does not create,
edit, enable/pause, or delete feeds. Conceptual questions ("what *is* a feed / a match field") are
domain knowledge and belong to the Data Readiness Hub domain expert, not this skill.
