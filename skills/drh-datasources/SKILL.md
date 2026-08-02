---
name: drh-datasources
title: Data Readiness Hub Data Sources
description: Data Readiness Hub databases & data sources — covers "list my data sources / databases", "get data source X", "what's the readiness status", database CDP/consolidation summaries, and recent activity. Read-only reporting on live Data Readiness Hub data via the Data Readiness Hub MCP server.
type: action
mcpToolFilter:
  - drh_list_databases
  - drh_get_database_by_id
  - drh_get_default_database
  - drh_list_deleted_databases
  - drh_list_sources
  - drh_get_source_by_id
  - drh_list_deleted_sources
  - drh_list_source_job_templates
  - drh_check_source_name_availability
  - drh_get_database_summary
  - drh_get_database_cdp_summary
  - drh_get_database_source
  - drh_list_database_sources
  - drh_get_database_consolidation_rate
  - drh_list_database_activities
operations:
  list:
    - drh_list_databases
    - drh_list_sources
    - drh_list_database_sources
  get:
    - drh_get_database_by_id
    - drh_get_default_database
    - drh_get_source_by_id
    - drh_get_database_source
  summary:
    - drh_get_database_summary
    - drh_get_database_cdp_summary
    - drh_get_database_consolidation_rate
    - drh_list_database_activities
maxSteps: 5
tags: [drh, datasources, databases, data-readiness]
---

# Data Readiness Hub Data Sources

Handle **read** operations on **Data Readiness Hub databases and data sources**: listing the registered
databases and sources, fetching one by id, and reporting a database's readiness/CDP/consolidation
summary and recent activity. Use the connected Data Readiness Hub tools to answer with real data — do not
describe concepts here (that is the `drh-domain-expert`'s job); this skill *acts*.

Data Readiness Hub sources and summaries are **scoped to a database**, and the deployment's database is applied
automatically — you don't supply, resolve, or ask for one. Just act; only pass a database id if the
user explicitly names a different database.

- **List** the databases or the sources within a database when the user asks what exists / to see them.
- **Get** a single database or source when the user names or ids one.
- **Summary** — report the database's readiness/health summary, CDP summary, consolidation rate, or
  recent activity when asked about data readiness/health or an overview.

Relay the tool's response back clearly. This skill is **read-only** — it reports, it does not create,
modify, pause, or delete anything. If a request is conceptual ("what *is* a data source / readiness")
rather than about the user's actual data, that is domain knowledge — it belongs to the Data Readiness Hub domain
expert, not this skill.
