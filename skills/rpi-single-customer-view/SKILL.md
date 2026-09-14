---
name: rpi-single-customer-view
title: RPI Single Customer View
description: Single Customer View (SCV) definitions in an RPI tenant — the unified customer-profile views and their attribute groups. Covers "list my single customer views", "get SCV X", "what attribute groups are in this SCV", and rendering an SCV event's details as HTML. Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - list_single_customer_views
  - get_single_customer_view
  - get_single_customer_view_by_name
  - get_single_customer_view_attribute_group
  - get_single_customer_view_attribute_group_by_name
  - get_single_customer_view_event_details_html
operations:
  list: [list_single_customer_views]
  get: [list_single_customer_views, get_single_customer_view, get_single_customer_view_by_name]
  attribute-groups: [list_single_customer_views, get_single_customer_view_attribute_group, get_single_customer_view_attribute_group_by_name]
  event-details: [get_single_customer_view_event_details_html]
maxSteps: 5
tags: [rpi, single-customer-view, scv, profile]
---

# RPI Single Customer View

Read-only reads for Single Customer View (SCV) — the unified customer-profile views
in an RPI tenant and their attribute groups. This skill inspects SCV *definitions*
and renders event detail cards; it does not build or edit views.

Apply foundation guidance: respect `clientId`, show names not IDs.

## The two levels (don't blur them)

- **SCV view** — the whole Single Customer View (a unified profile definition).
  `list_single_customer_views`, `get_single_customer_view` (by id),
  `get_single_customer_view_by_name`.
- **Attribute group** — a *grouping of attributes WITHIN* an SCV (a section of the
  profile). `get_single_customer_view_attribute_group` (by ids),
  `get_single_customer_view_attribute_group_by_name` (by names). This is a
  sub-structure of a view, NOT the view itself.

Plus **event details**: `get_single_customer_view_event_details_html` renders the
detail card for one channel-execution event (ChannelExecutionID +
OfferTemplateInstanceID + OfferCode) as HTML — an event view, distinct from the SCV
definition.

## Operations (menu-narrowing)

- **list** — browse SCV views.
- **get** — fetch one SCV view by id or name.
- **attribute-groups** — fetch an attribute group within an SCV (by id or name).
- **event-details** — render an SCV event's details as HTML.

Missing/unknown operation falls back to the full inventory (safe).

## Common workflows

- **"List my single customer views"** → `list_single_customer_views`.
- **"Get the SCV named X"** → `get_single_customer_view_by_name`.
- **"What attribute groups are in SCV Y?"** → `get_single_customer_view_attribute_group`
  (resolve the SCV id/name first via list/get if needed).

## Disambiguation (what this skill is NOT)

- **Not attributes / attribute lists** — those reusable attribute definitions are
  `rpi-attributes`. An SCV *attribute group* is a section of a profile view, not a
  tenant attribute list.
- **Not audiences / selection rules** — SCV is the profile view; the segmentation
  built over customer data is `rpi-audiences` / `rpi-selection-rules`.

> **Read-only skill.** Inspects SCV definitions and renders event details; changes nothing.
