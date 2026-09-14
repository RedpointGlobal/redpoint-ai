---
name: rpi-analysis
title: RPI Analysis & Reporting
description: Analysis and reporting objects in an RPI tenant — chart, cross-tab, and venn analysis panels (with their aggregations and colors), dashboards and widgets, channel-overview reports, and predictive model projects. The analytical VIEWS over client data, distinct from the data itself (rpi-databases). Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_chart_analysis_panel
  - get_chart_analysis_panel_available_aggregations
  - get_cross_tab_analysis_panel
  - get_cross_tab_analysis_panel_available_aggregations
  - get_cross_tab_analysis_panel_predefined_colors
  - get_venn_analysis_panel
  - get_dashboard
  - get_widget
  - get_channel_overview_results
  - get_model_project
operations:
  panels: [get_chart_analysis_panel, get_cross_tab_analysis_panel, get_venn_analysis_panel]
  panel-options: [get_chart_analysis_panel_available_aggregations, get_cross_tab_analysis_panel_available_aggregations, get_cross_tab_analysis_panel_predefined_colors]
  dashboards: [get_dashboard, get_widget]
  reports: [get_channel_overview_results, get_model_project]
maxSteps: 5
tags: [rpi, analysis, reporting, dashboards]
---

# RPI Analysis & Reporting

Read-only reads for the analytical objects over client data — analysis panels,
dashboards/widgets, channel-overview reports, and model projects. This skill is the
*views/outputs*, not the underlying data (that is `rpi-databases`).

Apply foundation guidance: respect `clientId`, show names not IDs.

## The sub-groups (keep them straight)

- **Analysis panels** (by type, by ID) — `get_chart_analysis_panel`,
  `get_cross_tab_analysis_panel`, `get_venn_analysis_panel`. A saved analysis over
  client data.
- **Panel options** — the selectable extras for a panel: aggregation functions
  (`get_chart_analysis_panel_available_aggregations`,
  `get_cross_tab_analysis_panel_available_aggregations`) and the cross-tab color
  palette (`get_cross_tab_analysis_panel_predefined_colors`, no ID — a catalog).
- **Dashboards & widgets** — `get_dashboard` (an arrangement of tiles),
  `get_widget` (one tile). A dashboard is made of widgets.
- **Reports & models** — `get_channel_overview_results` (delivery/response metrics
  for a channel over a date range) and `get_model_project` (a predictive model
  project).

Most getters are by **ID**. There is no list-all tool here — resolve an id via the
rpi-folders / file-info lookup or by folder if the user gives a name.

## Operations (menu-narrowing)

- **panels** — the three by-type panel getters.
- **panel-options** — aggregations + colors.
- **dashboards** — dashboard + widget.
- **reports** — channel-overview report + model project.

Missing/unknown operation falls back to the full inventory (safe).

## Disambiguation (what this skill is NOT)

- **Not the data** — databases, tables, keys, SQL definitions are `rpi-databases`.
  This skill is the analytical *views* over that data.
- **Not channels themselves** — a delivery channel's config is `rpi-integrations`;
  `get_channel_overview_results` here is the channel's *report* (metrics over a date
  range), not the channel object.
- **Not audiences / selection rules** — segmentation lives in `rpi-audiences` /
  `rpi-selection-rules`.

> **Read-only skill.** Inspects analysis/report objects; changes nothing.
