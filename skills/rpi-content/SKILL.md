---
name: rpi-content
title: RPI Content & Offers
description: Content and offer objects in an RPI tenant — digital content assets (HTML, text, image), content preview/combinations, smart (dynamic) assets, and offers (standard and Google Ads Customer Match). The reusable content a decision or interaction serves. Read-only.
type: action
clientIdFoundation: true
mcpToolFilter:
  - get_digital_html_content_asset
  - get_digital_text_content_asset
  - get_digital_image_content_file_asset
  - list_digital_image_content_file_assets
  - get_content_combinations
  - get_content_preview_html
  - get_smart_asset
  - get_smart_asset_javascript_snippet
  - get_offer
  - get_googleads_customer_match_offer
operations:
  digital-assets: [get_digital_html_content_asset, get_digital_text_content_asset, get_digital_image_content_file_asset, list_digital_image_content_file_assets]
  content-preview: [get_content_combinations, get_content_preview_html]
  smart-assets: [get_smart_asset, get_smart_asset_javascript_snippet]
  offers: [get_offer, get_googleads_customer_match_offer]
maxSteps: 5
tags: [rpi, content, offers, assets]
---

# RPI Content & Offers

Read-only reads for the reusable content and offer objects a decision or interaction
serves — digital assets, content preview, smart assets, and offers.

Apply foundation guidance: respect `clientId`, show names not IDs.

## The sub-groups (keep the content types straight)

- **Digital assets** — reusable content blocks by CONTENT TYPE: `get_digital_html_content_asset`
  (HTML), `get_digital_text_content_asset` (plain text), `get_digital_image_content_file_asset`
  (one image, by id) and `list_digital_image_content_file_assets` (browse images, paged).
  Name the type the user means — html vs text vs image.
- **Content preview** — `get_content_combinations` (the variants available for a
  file/content/template) and `get_content_preview_html` (render one as HTML).
- **Smart assets** — `get_smart_asset` (a dynamic/personalized asset) and
  `get_smart_asset_javascript_snippet` (its embeddable JS).
- **Offers** — `get_offer` (a standard offer) vs `get_googleads_customer_match_offer`
  (the Google Ads Customer Match template offer). Pick the GoogleAds getter ONLY when
  the user names Google Ads / Customer Match; otherwise `get_offer`.

Most getters are by **ID** (image list and the preview combinations are the
exceptions). Resolve an id via the rpi-folders / file-info lookup if the user gives a
name.

## Operations (menu-narrowing)

- **digital-assets** — html / text / image assets.
- **content-preview** — combinations + render-as-HTML.
- **smart-assets** — the asset + its JS snippet.
- **offers** — standard vs Google Ads Customer Match.

Missing/unknown operation falls back to the full inventory (safe).

## Disambiguation (what this skill is NOT)

- **Not the decision rules that SERVE this content** — that's `rpi-decision-rules`
  (decisioning) — this skill is the content/offers themselves.
- **Not analysis/dashboards** — analytical views are `rpi-analysis`.
- Within this skill: digital **image** asset (a content block) is not the same as a
  **smart** asset (dynamic/personalized); and `get_offer` (standard) is not
  `get_googleads_customer_match_offer` (the audience-sync template).

> **Read-only skill.** Inspects content/offer objects; changes nothing.
