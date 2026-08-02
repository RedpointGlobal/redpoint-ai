---
name: rpi-selection-rules
title: RPI Selection Rules
description: Selection rules (also called a segment or segmentation criterion) — the audience-building blocks underneath audiences. OWNS audience counts and segment counts — handles "how many records in this audience", "audiences with counts > 0", "list segments with counts > N", "run a count for rule X". Also covers "show me my selection rules / segments", "what does the SQL look like?", Basic vs Standard subtype routing, and waterfall analysis.
type: action
mcpToolFilter:
  - list_selection_rules
  - get_selection_rule_by_name
  - get_basic_selection_rule_by_id
  - get_standard_selection_rule_by_id
  - run_selection_rule_count
  - run_selection_rule_waterfall
  - get_selection_rule_sql_count_query
  - list_basic_selection_rule_document_definitions
operations:
  list: [list_selection_rules]
  get: [list_selection_rules, get_selection_rule_by_name, get_basic_selection_rule_by_id, get_standard_selection_rule_by_id]
  count: [list_selection_rules, run_selection_rule_count]
  waterfall: [list_selection_rules, run_selection_rule_waterfall]
  sql: [list_selection_rules, get_selection_rule_sql_count_query, get_basic_selection_rule_by_id, get_standard_selection_rule_by_id]
  definitions: [list_selection_rules, list_basic_selection_rule_document_definitions]
maxSteps: 10
tags: [rpi, selection-rules, segments]
---

# RPI Selection Rules

Tools for working with **selection rules**. When the user's prompt is about counts, waterfalls, or the criteria SQL, this skill is the right home.

RPI has two subtypes that LOOK identical in a list but require different fetch endpoints for full detail:

- **Basic** — represented internally as a "document-database-decision."
- **Standard** — straight standard-selection-rule.

The cardinal rule: **always read `subTypeName` from the list result and route to the correct `get_*` tool.** Calling the wrong one gives a 404.

Apply foundation guidance: respect `clientId`, look up `parentFolderID` via the folder-listing capability before any create call, show names not IDs.

**`clientId` handling.** Three cases:

1. **No `clientId` provided** (most common — generic requests like "list my selection rules") — OMIT the `clientId` argument entirely. The MCP server applies `RPI_DEFAULT_CLIENT_ID` from environment automatically. Do NOT ask the user for a clientId; do NOT refuse to proceed.

2. **`clientId` provided as a UUID** (8-4-4-4-12 hex, e.g. `a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890`) — pass it through unchanged.

3. **`clientId` provided as a non-UUID** (almost certainly a tenant *name* the parent agent forgot to resolve) — your sub-agent's tool filter does NOT include name-resolution. Stop and respond with a clear error asking the parent to redispatch via the **rpi-clients** skill to resolve the name to a UUID. Forwarding a name will fail with a 401 / "Client ID '00000000-0000-0000-0000-000000000000' not found" because RPI parses non-UUID input to the empty UUID.

## Tool inventory

### Discovery
- `list_selection_rules` — paginated search across both Basic and Standard. Card view returns `{id, name, description, parentFolderName, subTypeName}`. Optional `subType` filter to narrow to one subtype.
- `get_selection_rule_by_name` — exact (case-insensitive) name match. Returns `{found: true, matches: [...]}` (always an array; 2+ when the same name exists in multiple folders). Each match includes `subTypeName` so you can pick the correct detail tool. See "Handling multiple matches" below.

### Subtype-specific detail
- `get_basic_selection_rule_by_id` — full detail for Basic rules.
- `get_standard_selection_rule_by_id` — full detail for Standard rules.

### Job execution
- `run_selection_rule_count` — start a count job, poll until done, return the count. Works for either subtype (the count job dispatches by ID, not subtype).
- `run_selection_rule_waterfall` — start a waterfall job (step-by-step count breakdown), poll until done, return results. Same lifecycle as count.

### SQL inspection (Standard only)
- `get_selection_rule_sql_count_query` — fetch the generated SQL `COUNT(*)` query for a Standard rule. No job execution. Use this to preview or debug query generation.

### Basic rule schemas
- `list_basic_selection_rule_document_definitions` — list document definitions available for Basic rules in this tenant.

## Common workflows

### Truncating a long list for display

`list_selection_rules` returns a bounded preview — **the first 10** (the tool defaults `pageSize` to 10; do **not** set it). The response still reports the total M, so append one line: *"Showing N of M. Filter by name or description substring — e.g., 'list selection rules matching MW'."* Never fetch the whole set to "show all" — the top-10 preview is intentional; narrow with a filter to find specific selection rules.

### "Show me selection rule X"
1. `get_selection_rule_by_name` (or `list_selection_rules` with `nameFilter`).
2. Take `matches[0]` (see "Handling multiple matches" if `matches.length > 1`) and read its `subTypeName`.
3. Branch:
   - `subTypeName === "Basic"` → `get_basic_selection_rule_by_id`.
   - `subTypeName === "Standard"` → `get_standard_selection_rule_by_id`.
4. Surface the rule's name, description, and key criteria. Avoid dumping the full payload.

### Handling multiple matches for a selection rule name

`get_selection_rule_by_name` returns `{found: true, matches: [...]}` — `matches.length` can be 1, or more if multiple rules share the exact (case-insensitive) name across different folders.

- **1 match:** proceed using `matches[0].id` (and its `subTypeName`).
- **2+ matches:** display each with `name` + `fullPath` (the full folder path) + `subTypeName` (e.g., "`Females` (Standard) at `…\Marketing\Females`" vs "`Females` (Basic) at `…\Archive\Females`") and ask the user which one. If `fullPath` is empty, fall back to `parentFolderName`. Never silently pick the first, and never show GUIDs (`id`, `parentFolderID`).
- **0 matches:** fall back to `list_selection_rules(nameFilter: name)` for fuzzy results before declaring "not found".

### "How many records would this rule return?"
1. Resolve rule `id` (steps 1–2 above; you don't need the full detail, just the ID).
2. `run_selection_rule_count` with the `id`. Tool blocks on a default 220-second timeout, polling internally.
3. Surface the count.

If the count tool times out, the rule may be against a slow data source — surface the timeout and suggest the user increase `timeoutSeconds` (range 5–3600) or split the rule.

### "Break down where records drop off in this rule"
This is the waterfall use case (rule has multiple criteria; you want to see how many records survive each step).

1. Resolve `id`.
2. `run_selection_rule_waterfall` with the `id`.
3. Surface the per-step counts in order. The largest drops are the criteria the user likely wants to scrutinize.

### "Show me the SQL for Standard rule X"
1. Resolve `id` for a Standard rule (don't run on Basic — endpoint is Standard-only).
2. `get_selection_rule_sql_count_query` with the `id`.
3. Format the SQL for readability before showing it.

### "What document definitions are available for Basic rules?"
1. `list_basic_selection_rule_document_definitions` — no parameters required beyond `clientId`.
2. Show names and descriptions.

## Subtype filtering on list

`list_selection_rules` accepts a `subType` argument:
- Omit → both subtypes returned.
- `"Basic"` or `"Standard"` → only that subtype.

Use the filter when the user explicitly says "list my Standard rules" or "show me Basic decisions"; otherwise leave it off.

## Count-predicate intent — list all, then count, then filter

When the user's prompt is a **count predicate** ("with counts > 0", "non-zero counts", "size > N", "more than M records") on the OBJECT CLASS:

- Do NOT pass `nameFilter` to `list_selection_rules`. The user's noun ("audiences", "segments", "rules") is a USER-FACING CONCEPT, NOT a literal name fragment to substring-match against.
- Default to NO filter: list everything (paginate if needed), run `run_selection_rule_count` per row, then apply the predicate to the count results.
- Reflexively passing the class noun as `nameFilter` (e.g. `nameFilter: "audience"` for "audiences with counts > 0") silently returns the wrong slice — usually nothing — and produces a confidently-wrong "no results" answer.

Worked example — *"list audiences with counts > 0"* (a count predicate over a class noun → a potentially large set):

1. `list_selection_rules` (NO `nameFilter` for a bare class noun; DO pass `nameFilter` when the user gave real name material like "MW"; NO `subType` unless the user said one) → `{id, name, subTypeName, …}` cards in list order.
2. **Count up to the first 10 cards, then STOP.** `run_selection_rule_count(id, subTypeName)` for each (sequential, ~2s/job); apply the `> 0` predicate; present what passes.
3. Close with the honest scope — *"Here are the rules with counts > 0 among the first 10 of M matching."* No "next page" offer.

The general principle: ask *"is the user pointing at a record's name, or naming the object class they want enumerated?"* Class noun → no filter. Specific name material from the user → use `nameFilter`.

**Anti-loop (critical).** `list_selection_rules` NEVER returns counts — counts come ONLY from `run_selection_rule_count` per id. Re-calling `list_selection_rules` will return the SAME count-less cards every time. Do NOT re-list looking for counts; if you have the cards, move straight to per-row counting. (Re-listing on a loop until `maxSteps` and then asking the user is the failure mode this guidance exists to prevent.)

**Cap at 10, don't grind, don't paginate, don't ask permission.** Each count is a per-rule job (~2s, no bulk count exists), so counting hundreds is minutes of wall-time and hammers the count-job backend. The discipline:
- **Bound first** with `nameFilter` when the user gave name material ("MW", "welcome").
- **Count at most the first 10 rows in list order, then STOP.** Hard cap (~10 count jobs/turn) whether the candidate set is 19 (name-filtered) or 242 (unfiltered), even if the user says "all". It's a fixed slice of 10 *rows*, NOT "count until 10 results pass" — if only 2 of the 10 you counted have `count > 0`, show those 2 and stop; do NOT count more rows to fill it. **Do not offer to continue or paginate** — no "next 10", no cursor, no offset follow-ups.
- **Do NOT claim completeness you don't have.** You counted only the first 10, so you do NOT know the counts of the rest. NEVER write "all other rules have a count of zero" or imply the un-counted rows are empty — that's false and a rep will read it as fact. Correct close: *"Here are the rules with counts > 0 among the first 10 of M matching — ask about a specific rule for its detail."* You may list the zero-count rows **from those 10 only**, labeled as such.
- **Small sets (≤ 10 candidates): count them all** — here you HAVE checked every row, so "all others are zero" IS accurate and fine to say, and there's nothing left uncounted.
- Counts are reported in **list order**, NOT ranked by size — ranking would require counting everything first, the exact cost we're avoiding. Don't claim the results are the "largest".
- Never punt a count predicate back to the user as a clarifying question.

## Display guidance recap

- Show `name` and `subTypeName` (so the user knows whether they're looking at Basic or Standard). Don't show the underlying `document-database-decision` jargon — that's an implementation detail.
- For results from count / waterfall, present numbers as formatted integers (e.g., `12,345`), not raw strings.
- For SQL output, wrap in a code fence and avoid editorializing the query — show what RPI generated.

## Job timeouts

Both `run_selection_rule_count` and `run_selection_rule_waterfall` accept `timeoutSeconds` in the range 5–3600 (default 220). The MCP transport aborts at ~240s, so raising it past that cannot buy more time — the call dies mid-flight instead of returning a clean timeout. The polling cadence is 1 second.

## Response discipline — applying user-supplied predicates

When the user includes a numeric or boolean predicate in their prompt (`age > 20`, `count > 0`, `subType == 'Basic'`), **APPLY it.** Keyword-matching rule NAMES that resemble the predicate is NOT applying the filter. Concrete example: for a query *"list rules with age > 20"*, returning **"Age is over 17"** because its name contains "age" is wrong — `>17` includes 18, 19, 20 and fails the `>20` predicate. The rule NAME is not the rule's SQL criterion; they can diverge sharply.

If the predicate can't be applied without fetching rule criteria (i.e., the list tool doesn't return the property), surface that explicitly — don't quietly drop it. Either chain to follow-on tools that fetch the criterion data, or honestly disclaim: *"I can list rules whose names match 'age' but I can't verify which actually filter by age > 20 without inspecting each rule's SQL criterion — want me to fetch those?"*

**Rule NAME ≠ rule SQL criterion. Do NOT claim filter compliance you didn't verify.** This applies equally to count predicates, subtype predicates, date predicates, and any other criterion the user can name.
