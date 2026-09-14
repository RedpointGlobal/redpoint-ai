---
name: rpi-integrations
title: RPI Integrations & Data Movement
description: External connectivity and data movement for an RPI tenant — FTP locations, web adapters, web publish site maps, channels, data-connector syncs, data imports, and export templates. Covers "list my FTP locations", "web adapters", "web publish site maps", "list channels", "data connector sync status", "data import files", "export templates". The plumbing that moves data in and out; NOT the data itself (rpi-databases) or content assets (rpi-content). Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - list_ftp_locations
  - get_ftp_location
  - get_ftp_location_by_name
  - list_web_adapters
  - get_web_adapter
  - get_web_adapter_by_name
  - list_web_publish_site_maps
  - get_web_publish_site_map
  - get_web_publish_site_map_by_name
  - list_channels
  - get_data_extract_channel
  - get_data_connector_sync_definition
  - list_data_connector_sync_info
  - get_data_import_file
  - get_data_import_file_housekeeping_records
  - get_data_import_file_system_configuration
  - list_data_import_file_system_files
  - get_export_template
operations:
  ftp: [list_ftp_locations, get_ftp_location, get_ftp_location_by_name]
  web-adapters: [list_web_adapters, get_web_adapter, get_web_adapter_by_name]
  web-publish: [list_web_publish_site_maps, get_web_publish_site_map, get_web_publish_site_map_by_name]
  channels: [list_channels, get_data_extract_channel]
  connectors: [get_data_connector_sync_definition, list_data_connector_sync_info]
  data-import: [get_data_import_file, get_data_import_file_housekeeping_records, get_data_import_file_system_configuration, list_data_import_file_system_files]
  export-template: [get_export_template]
maxSteps: 5
tags: [rpi, integrations, ftp, channels, data-movement]
---

# RPI Integrations & Data Movement

Read-only reads for the tenant's **integration plumbing** — how data moves in and
out: FTP, web adapters, web-publish site maps, channels, data-connector syncs, data
imports, and export templates. This skill inspects the *connectivity/config*; it is
not the data itself (`rpi-databases`) nor content assets (`rpi-content`).

Apply foundation guidance: respect `clientId`, show names not IDs.

## Operations (this skill is broad — pick the operation to narrow the menu)

Each exposes a ≤5-tool menu:

- **ftp** — FTP locations (`list_ftp_locations`, `get_ftp_location`,
  `get_ftp_location_by_name`).
- **web-adapters** — web/site adapters (`list_web_adapters`, `get_web_adapter`,
  `get_web_adapter_by_name`).
- **web-publish** — web publish site maps (`list_web_publish_site_maps`,
  `get_web_publish_site_map`, `get_web_publish_site_map_by_name`).
- **channels** — `list_channels`, `get_data_extract_channel`.
- **connectors** — data-connector syncs: `get_data_connector_sync_definition`
  (config) + `list_data_connector_sync_info` (live status by WorkflowAssociationID).
  The activate/deactivate ACTIONS are intentionally not exposed (read-only surface).
- **data-import** — inbound imports: `get_data_import_file` (+ its
  `get_data_import_file_housekeeping_records`) and the import file-SYSTEM
  (`get_data_import_file_system_configuration`, `list_data_import_file_system_files`).
- **export-template** — `get_export_template` (outbound export column/format defn).

Missing/unknown operation falls back to the full 18-tool inventory (safe).

## Common workflows

- **"List my FTP locations"** → `list_ftp_locations`.
- **"Show my web publish site maps"** → `list_web_publish_site_maps`.
- **"What's the sync status for workflow association X?"** →
  `list_data_connector_sync_info` (WorkflowAssociationID); its config is
  `get_data_connector_sync_definition`.
- **"List the files in my import drop"** → `list_data_import_file_system_files`;
  the FS config is `get_data_import_file_system_configuration`.

## Disambiguation (what this skill is NOT)

- **Not the databases / data model** — the data itself (databases, keys, SQL defs,
  table joins) is `rpi-databases`. Here it's the *movement/connectivity* of data.
- **Not content assets** — digital/smart assets and offers are `rpi-content`.
- Within this skill: **web-adapters** (channel/site connectors a decision uses) vs
  **web-publish** (published site maps) vs **channels** (delivery channels) are
  distinct — name the one the user means.

> **Read-only skill.** Inspects integration config/status; moves/changes nothing.
