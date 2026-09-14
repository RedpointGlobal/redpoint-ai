---
name: rpi-decision-rules
title: RPI Decision Rules
description: Decision rules in an RPI tenant — the DECISIONING logic that picks an outcome (which offer/content/branch) for a record, by data-source type (database, JSON, web, orchestration, attribute-list), plus their adaptors/dynamic-content lists and available criteria. NOT selection rules (segmentation — which records qualify); those are rpi-selection-rules. Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_database_decision_rule
  - get_json_decision_rule
  - get_web_decision_rule
  - get_orchestration_decision_rule
  - get_attribute_list_decision_rule
  - list_web_decision_rule_adaptors
  - list_orchestration_decision_rule_dynamic_content_files
  - list_attribute_list_decision_rule_lists
  - get_decision_rule_available_criterion
  - get_decision_rule_available_sql_database_criterion
operations:
  rules: [get_database_decision_rule, get_json_decision_rule, get_web_decision_rule, get_orchestration_decision_rule, get_attribute_list_decision_rule]
  related: [list_web_decision_rule_adaptors, list_orchestration_decision_rule_dynamic_content_files, list_attribute_list_decision_rule_lists]
  criteria: [get_decision_rule_available_criterion, get_decision_rule_available_sql_database_criterion]
maxSteps: 5
tags: [rpi, decision-rules, decisioning]
---

# RPI Decision Rules

Read-only reads for **decision rules** — the decisioning logic that selects an
*outcome* (an offer, content variant, or journey branch) for a record. A decision
rule is distinct from a **selection rule**: decisioning (what to do) vs segmentation
(who qualifies).

Apply foundation guidance: respect `clientId`, show names not IDs.

## The rule types (by data source)

A decision rule's type is its input source — name the type the user means:
- **database** — `get_database_decision_rule` (criteria from a client table).
- **json** — `get_json_decision_rule` (input is a JSON message / real-time).
- **web** — `get_web_decision_rule` (fires on a web/site interaction); its site
  connectors are `list_web_decision_rule_adaptors`.
- **orchestration** — `get_orchestration_decision_rule` (branches a journey inside an
  interaction); its referenced dynamic-content files are paged by
  `list_orchestration_decision_rule_dynamic_content_files`.
- **attribute-list** — `get_attribute_list_decision_rule` (selects from an attribute
  list); the lists usable in it are `list_attribute_list_decision_rule_lists`.

Getters are by rule **ID**. There is no list-all-decision-rules tool here — resolve a
rule's id via the file-system card (the rpi-folders / file-info lookup) or by folder
if the user gives a name.

## Operations (menu-narrowing)

- **rules** — the five by-type getters (database/json/web/orchestration/attribute-list).
- **related** — the per-type sub-lists (web adaptors, orchestration dynamic-content
  files, attribute-list decision-rule lists).
- **criteria** — the fields a rule can be built on: `get_decision_rule_available_criterion`
  (generic) vs `get_decision_rule_available_sql_database_criterion` (SQL-definition-sourced).

Missing/unknown operation falls back to the full inventory (safe).

## Disambiguation (what this skill is NOT)

- **NOT selection rules** — `rpi-selection-rules` owns segmentation (which records
  qualify, counts, waterfall, Basic/Standard subtypes). This skill owns
  *decisioning* (which outcome a record gets). "selection rule / segment / count" →
  rpi-selection-rules; "decision rule / decisioning / offer-decision" → here.
- **Not offers/content** — the offers and content a decision serves are `rpi-content`.
- **Not the attribute list itself** — `get_attribute_list_decision_rule` is the RULE;
  the attribute lists it references are `rpi-attributes`.

> **Read-only skill.** Inspects decision-rule definitions; changes nothing.
