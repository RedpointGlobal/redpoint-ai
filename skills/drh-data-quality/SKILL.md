---
name: drh-data-quality
title: Data Readiness Hub Data Quality
description: Data Readiness Hub data quality & subject areas — covers "hygiene scores", "match confidence", "processed matches", "list subject areas", "show subject area X and its columns". Read-only reporting on live Data Readiness Hub data-quality metrics via the Data Readiness Hub MCP server.
type: action
mcpToolFilter:
  - drh_get_data_quality
  - drh_get_data_quality_by_id
  - drh_get_hygiene_scores
  - drh_get_match_confidence
  - drh_get_processed_matches
  - drh_list_subject_areas
  - drh_get_subject_area
  - drh_get_subject_area_columns
  - drh_list_deleted_subject_areas
operations:
  quality:
    - drh_get_data_quality
    - drh_get_data_quality_by_id
    - drh_get_hygiene_scores
    - drh_get_match_confidence
    - drh_get_processed_matches
  subjectareas:
    - drh_list_subject_areas
    - drh_get_subject_area
    - drh_get_subject_area_columns
maxSteps: 5
tags: [drh, data-quality, subject-areas, data-readiness]
---

# Data Readiness Hub Data Quality

Handle **read** operations on **Data Readiness Hub data quality and subject areas**: reporting hygiene scores,
match confidence, and processed matches, and listing/fetching subject areas and their columns. Use
the connected Data Readiness Hub tools to answer with real data — do not describe concepts here (that is the
`drh-domain-expert`'s job); this skill *acts*.

Data-quality metrics are **scoped to a database**, and the deployment's database is applied
automatically — you don't supply, resolve, or ask for one. Just act; pass an id only when the user
names a specific data-quality record or subject area.

- **Quality** — report hygiene scores, match confidence, or processed matches when the user asks how
  clean/matched/ready the data is.
- **Subject areas** — list the subject areas or fetch one and its columns when asked about the data
  model / schema.

Relay the tool's response back clearly. This skill is **read-only** — it reports metrics, it does
not create or delete data-quality records or edit subject areas. Conceptual questions ("what *is*
match confidence / a subject area") are domain knowledge and belong to the Data Readiness Hub domain expert.
