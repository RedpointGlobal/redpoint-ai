# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [7.185]

### Documentation

- **The skill and scenario counts match the tree.** The FAQ said 15 skills (11 action, 4 experts); there are 28 (24 action, 4 experts: RPI 21, DRH 7). The routing-eval README said 14 scenarios; the eval runs 57 RPI scenarios, 9 Data Readiness Hub scenarios and 5 chains, and its chain section now describes the setup's token, the per-key failure and the client chain's route-and-call judgment. The tool counts (RPI 197 = 44 of 49 hand-written + 153 generated; DRH 57 of 93) were already right.

## [7.184]

### Fixed

- **THIRD-PARTY-LICENSES.md lists every installed package version, and the list no longer depends on the install.** The generator read only the one version Bun hoists per package name, so 81 installed package versions (an older or newer major of a package that is installed twice) had no entry, and which version was listed could change between two installs of the same lockfile. It now reads every entry of Bun's package store: 1014 packages (was 930). A test with a two-version fixture store holds it.

## [7.183]

### Fixed

- **THIRD-PARTY-LICENSES.md lists the dependencies this tree installs.** It had not been regenerated after the dependency updates in 7.155 and 7.162 (hono 4.13.13, @hono/node-server 1.19.15, adm-zip 0.6.1, fast-uri 3.1.9, qs 6.16.1, ip-address 10.7.4, js-yaml 3.15.2, brace-expansion 1.1.21, side-channel 1.1.1). A test now runs `bun run licenses --check`, so the file can't go stale silently again.

## [7.182]

### Changed

- **Two ways to sign in: SSO or native RPI credentials.** SSO is redirect-only (OIDC authorization_code + PKCE). The SSO password form is gone from the login page, and so is the server-side password grant behind it (the `keycloak-sso` provider): a username and password posted to it no longer sign anyone in. Native RPI sign-in is unchanged.
- **The SSO redirect needs this app's redirect URI registered on your Keycloak realm's client** (`<web origin>/api/auth/callback/sso`). Until it is, the identity provider refuses the redirect, and native RPI credentials are the way in.

## [7.181]

### Security

- **A model answer can't make the browser fetch a URL.** A model answer can carry text an attacker planted in data the agent read, so markdown images in chat answers render as their alt text (or `[image]`), never as an `<img>` that would fetch on render; and every page sends a Content-Security-Policy whose `img-src` is the app itself and in-page data only (`'self' data: blob:`), so no other image source loads even if one slips through.

## [7.180]

### Security

- **Request limits, with auth on.** The app server now bounds what one caller can cost it: a per-peer flood ceiling before auth (1200 a minute); per user, 120 requests a minute on every `/api/v1` call, 20 chat turns a minute (the chat route and the AG-UI run stream), 5 open trace streams, and 10 API keys minted an hour. Past a budget the answer is 429 with `Retry-After`. A presented RPI token is validated with RPI under the same bounds the RPI MCP server uses (a 30-second answer cache, single-flight, a per-token failure budget). The limiter, the validation guard and the serve mode are the RPI MCP server's own code, mirrored (a test holds them identical); the request body is capped at 4 MiB. All per-user budgets are off in dev mode (auth off), so the default local run is unchanged.

## [7.179]

### Security

- **Workspace configuration can't be changed with auth on.** Workspaces are shared by every user, and a workspace's config decides where every user's token goes (its MCP URLs) and what the server runs. Creating, updating or deleting a workspace now returns 403 for every authenticated caller (RPI user, OIDC, API key); dev mode (auth off, one local operator) may still write. The web UI never writes them.
- **A user's data is theirs.** Threads (their messages, runs and AG-UI streams) belong to the identity that created them; any other caller, and a thread fetched under another workspace's id, gets 404. The telemetry trace (which carries each tool call's result) is kept per workspace and user, and `/trace`, its stream and `?clear=1` touch the caller's own events only.
- **API keys belong to the user who minted them and act as that user.** A key can't mint keys; list and delete show your own keys only; a key scoped to a workspace gets 404 elsewhere; keys expire in 90 days by default (365 at most); the unenforced `permissions` field is refused.

### Upgrade notes

- The owner tables (`thread_owners`, `api_key_owners`) are created at boot. With auth on, threads and trace events created before this release have no owner and are invisible (404) to every user; dev mode still sees them. A boot that can't complete the schema now fails loudly instead of continuing.

## [7.178]

### Security

- **The caller's RPI identity goes to the RPI MCP connection only.** The app server injected the RPI tenant (`clientId`) into every tool call, the DRH server's included (which read it as its own tenant), and forwarded the signed-in user's RPI token to every HTTP MCP connection. Both now go to the `rpi` connection only; the DRH server and user-configured connections get neither and use their own shared client (DRH in its own default tenant).

## [7.177]

### Fixed

- **A signed-in user's MCP sessions end with each turn.** For a signed-in user the app server opens a fresh MCP client per request (carrying the user's token), but it never closed it: each session stayed open on the RPI MCP server until its 30-minute idle expiry, and that server caps each user's open sessions (20 in token mode), so a busy user was refused after about 20 turns in half an hour. The turn now releases its clients when it ends (chat, the workspace tools listing and runtime probe, A2A), and closing a client ends its session on the server (MCP `DELETE` with the session id, best effort and bounded). The shared, signed-out path is unchanged.

## [7.176]

### Security

- **The app server's CORS admits the web UI's origin only, never `*`.** It was `cors()` (every origin). Now only `http://localhost:3001` and the origin of `RPI_AI_AGENT_REDIRECT_URL` (the web app's public origin) get `Access-Control-Allow-Origin`; any other origin gets none, so a page on another site can't read this server's responses. The web UI calls the server through its own same-origin `/api/proxy/*` routes, which CORS doesn't govern. A third-party page that read the API cross-origin stops working.

## [7.175]

### Changed (breaking for A2A)

- **A2A declares its auth mode explicitly: `A2A_AUTH_MODE` is required (`bearer` or `oidc`), with no default and no fallback.** A deployment that set only `A2A_ENABLED` and `A2A_BEARER_TOKEN` must add `A2A_AUTH_MODE=bearer` after upgrading: with no mode (or an unknown one) the A2A server does not start; the app keeps running and logs the reason to stderr. It never starts open.

### Added

- **A2A per-user sign-in (`A2A_AUTH_MODE=oidc`).** Each caller's token is verified before the JSON-RPC handler runs, the same two-step way the RPI MCP server does it: locally as a JWT from the RPI realm's OpenID provider (discovered from RPI's login settings at boot), else by RPI itself (`validate-token-status`, then the caller's identity). Service accounts and the configured proxy user (`RPI_PROXY_USER`) are refused. The agent's tools then run as that caller: their token is forwarded to the MCP servers. `oidc` requires every MCP server of the A2A workspace to refuse unauthenticated calls (for the RPI MCP server, `AUTH_REQUIRED=true`); the A2A server checks this at boot and does not start otherwise. The agent card advertises the mode. `bearer` keeps today's single shared token.

## [7.174]

### Added

- **The app server has its own copy of the RPI MCP server's OIDC discovery and JWKS verifier** (`apps/server/src/auth/oidc-discovery.ts`), for A2A's per-user sign-in (next release). The MCP server is a standalone binary with no shared package, so the two files are mirrors: a test fails unless they are identical apart from imports and the app server copy's header line.

## [7.173]

### Changed

- **The source cites no internal work-item numbers, nicknames or names.** Comments, scenario notes and test fixtures say what they mean in plain words, and one test prompt no longer quotes part of a real tenant's name. A test (`scripts/__tests__/no-work-item-numbers.test.ts`) fails the build on a work-item number anywhere in the tracked tree.

## [7.172]

### Fixed

- **The routing eval's chain scenarios run again.** The chain setup seeded its records with the RPI client and no token, which the client refuses, so every chain failed before any prompt ran. It now uses the service-account token and seeds the client chain from the caller's own tenants (the cluster-wide list is a cluster-admin read); a key whose setup read fails fails only its own chain scenario; the client-by-name chain is judged on its route and its call (reading a client is a cluster-admin read, refused for a non-admin login).
- **`rpi-clients` names no other skill's tool in its description.** It named `rpi-admin`'s `get_user_client_list`; it now names `rpi-admin`. A test holds that an action or hybrid skill's description names only its own tools, and the skill-body check also catches a tool named without backticks. The skill text moves the routing fingerprint.
- **The API-key auth test brings its own database**, so it passes on a fresh clone.

## [7.171]

### Changed

- **`rpi-interactions` names the summary's new fields.** The `summarize_interaction_runs` bullet says `testRuns` and `productionRuns` are real run counts, that the top list is ranked by real runs, and to relay `runsPerInteractionNote` as well as `truncationNote`, never presenting a partial summary as complete. The text is identical on the web, orchestrator and OSS lines. It moves the routing fingerprint, so the routing eval is restamped.

## [7.170]

### Fixed

The inline RPI MCP server (`packages/mcp-rpi`) is 7.227, the standalone RPI MCP server's 7.227 change.

- **`summarize_interaction_runs` returns real run counts, one row per interaction.** RPI ignores `pageNumber` on `POST /client/files/reports/interaction`: every page number returns page 1 with the same rows. The tool paged until `currentPage` reached `totalNumberOfPages`, which never happened, so it re-fetched page 1 until its 50-page or 20-second limit: every interaction appeared many times with a run count of 1, `totalRuns` was that row count times the pages fetched (it varied from call to call), and a false "summary is incomplete" note was attached. A report row's `executedWorkflowCount` is also not a run count (one row said 1 for an interaction that ran 216 times). Now:
  - the interactions come from **one** report request at the 255-row maximum, never paged; `truncated` is true only when that response says there is more than one page (`truncationNote` then says the interaction figures are partial);
  - `totalRuns`, and the new `testRuns` and `productionRuns`, come from RPI's run counts (`POST /client/files/reports/interaction/run-counts`, one tenant-wide call);
  - rows are grouped per interaction by `file.versionControlID` (every version of the interaction; `file.id` names one version and misses the runs of the others), and `activeInteractions`, `testInteractions` and `productionInteractions` count interactions, not rows;
  - `runsPerInteraction` (top 10) is ranked by each interaction's real run count: run counts are requested for up to the 25 most recently active interactions, five at a time within 3.5 seconds. When not every interaction could be counted, `runsPerInteractionNote` says the ranking is partial.

  The tool declares both endpoints in `_meta.endpoints`. Measured on a live tenant: 0.85–2.2 s per call (the 16–25 run-count calls take 0.27–0.74 s); totals equal `get_interaction_run_counts` for the same window.

## [7.169]

### Fixed

- **A health, single-customer-view, users-and-permissions, operations or cluster-user question always reaches the tool it needs.** Five small skills split their tools into operations, and each operation held only its own group: under `availability`, `rpi-health` had no monitoring overview; under `get` or `list`, `rpi-single-customer-view` had no named attribute group, and under `event-details` no view list; under `users`, `rpi-users-permissions` had no user's permissions, and under `permissions` no user list; under `logs`, `rpi-operations` had no execution services, and under `jobs` no audit history; under one of `internal-users` / `external-users`, `rpi-cluster-users` had no list of the other kind. When the router passed such an operation, the sub-agent could not reach the tool. Each of these skills (2 to 8 tools) now declares no operations, so the sub-agent always gets its whole menu, as `rpi-decision-rules` already does. The skills' text moves the routing fingerprint, so the routing eval is restamped. Unit tests pin each skill's full tool list by name and that it declares no operations.

## [7.168]

### Fixed

- **A decision-rule question always reaches the tool it needs.** `rpi-decision-rules` declared three operations (`rules`, `related`, `criteria`). The router sometimes sent "list the adaptors for my web decision rules" or "list the dynamic content files for my orchestration decision rules" as `rules`, which held only the five by-type getters, so the sub-agent had no list tool and answered without one (seen in the routing eval). The skill now declares no operations: its ten tools are one small menu and the sub-agent always gets all of them. This is the orchestrator line's fix (2.4), ported. The skill's text moves the routing fingerprint, so the routing eval is restamped. A unit test pins that the skill declares no operations.

## [7.167]

### Fixed

- **"Which clients can I access?" is answered under the diagnostics operation too.** The router sometimes sends the question to `rpi-admin` as `diagnostics` (seen in the routing eval). That menu held only the cluster error log, the cluster audit history and the connection check, so the sub-agent checked the connection and answered without the list. `get_user_client_list` is now in `diagnostics` as well as `identity` and `auth`. The router prompt is unchanged; the skill's text moves the routing fingerprint, so the routing eval is restamped. A unit test pins the `diagnostics` menu, and the three diagnostics scenarios (cluster errors, cluster audit history, connection check) now fail if they call the client list.

## [7.166]

### Fixed

- **A sub-agent that sends the same call several times at once keeps its tools for the next step.** The repeated-call guard (7.340) stopped offering tools once it had short-circuited two calls. A model can send the same call many times in parallel in one step (10 `get_interaction_by_id` calls were seen): two ran, eight were short-circuited, and the next step lost its tools before the model had seen a stop message, so a last-run question was answered without the counts. The guard now counts the steps in which it short-circuited a call: after one such step the sub-agent keeps its tools, with the stop messages in view; repeating the call in a second step ends the loop as before. Router-facing source (`router.ts`): the routing eval is restamped.

## [7.165]

### Fixed

- **An interaction's detail is read under the runs operation too.** "List my interactions, then show me the details of X and its last run's counts" is split into dispatches that are all routed to `rpi-interactions` as `runs`. The detail dispatch reads the interaction with `get_interaction_by_id`, which was only in `get`: the sub-agent asked for a tool it didn't have (up to 10 times in one step) and answered without the detail. `get_interaction_by_id` is now in `runs` as well. The router prompt is unchanged; the skill's text moves the routing fingerprint, so the routing eval is restamped. A unit test pins the `runs` menu.

## [7.164]

### Fixed

- **A sub-agent that uses its whole step budget still answers.** When a dispatch's last allowed step was a tool call, the call ran, the budget ended the loop, and the sub-agent returned empty text. That last step (step `maxSteps`, the last one the budget allows) may now not call tools (`toolChoice: "none"`), so every dispatch ends on a text answer from what it gathered. A skill with a budget of 1 keeps its tools. Router-facing source (`router.ts`): the routing eval is restamped.

## [7.163]

### Fixed

- **A sub-agent that keeps repeating a blocked tool call answers instead of using up its steps.** The repeated-call guard stops the 3rd identical call (same tool, same arguments) from running and tells the sub-agent to answer, but the model could keep asking for it until the dispatch hit its step budget. The guard now counts each call it stops; after the second one, the sub-agent's next step may not call tools (`toolChoice: "none"`, tool definitions kept) and answers from the results it already has. Calls with different arguments, and a single repeat, are unaffected. Router-facing source (`router.ts`): the routing eval is restamped.

## [7.162]

### Changed

- **The RPI and DRH MCP servers report the versions their code is: 7.226 and 7.215** (they said 7.224 and 7.213). The changes in those versions are dependency updates, which reached these packages in 7.155: zod 4.6.6, body-parser 2.4.0, hono 4.13.13 and the MCP SDK's runtime dependencies at their fixed releases. The tools are unchanged.
- `docs/rpi-mcp-server.md`'s Tool Filtering section: an unfiltered `tools/list` returns all 197 tools (it said 47).

### Security

- **adm-zip 0.6.1** (was 0.5.16), which writes the binary release zips and the docker bundle: the advisories below 0.6.0.

## [7.161]

### Changed

- **The docs give the tool counts the servers actually list.** The RPI MCP server lists 197 tools: 44 of its 49 hand-written tools (5 writes are gated) plus 153 read tools generated from the RPI OpenAPI spec; the 44 include the two allowed selection-rule runs (`run_selection_rule_count`, `run_selection_rule_waterfall`), so they aren't "197 read tools". The DRH MCP server lists 57 of its 93 (36 writes gated). README, `docs/architecture.md`, `docs/rpi-mcp-server.md`, `docs/faq.md` (its interactions row is 18 tools, with `summarize_interaction_runs` and `get_interaction_run_counts`), `docs/getting-started.md` and `docs/skills.md` said 47, "42 of 47" or "197 read tools".

### Added

- **`docs/drh-mcp-server.md`**, the Data Readiness Hub MCP server's page next to `docs/rpi-mcp-server.md`: its tool domains, configuration, authentication and limits, and how to build the binaries. Linked from the README and `docs/getting-started.md`.

## [7.160]

### Fixed

- **A saved RPI dashboard asked for by id or name is read, not rendered or answered in text.** "Get the dashboard with id …" is a read of a saved dashboard (`rpi-analysis`, operation `dashboards`). The dashboard steering told the router to call `render_view_dashboard` for any dashboard request, so it sometimes answered in text without dispatching or rendered a view instead. The steering and `render_view_dashboard`'s description now send a saved dashboard or widget asked for by id or name to `rpi-analysis`. Building a dashboard from data is unchanged. Router-facing text: the routing eval is restamped.

## [7.159]

### Fixed

- **A last run's result counts are read, not paged for.** "What were the result counts from the last run of my …?" is routed to `rpi-interactions` as `runs`, whose menu held only the all-interactions date-range summary and the interaction list. The skill reads a last run with `get_interaction_by_name` then `get_interaction_workflow_instances`, and neither was in `runs`: the sub-agent paged the interaction list 3 to 10 times and the router sometimes dispatched again. Both are now in `runs` too. The router prompt is unchanged.

### Added

- **Chain scenario `chain-interaction-last-run-counts`:** a real interaction's last-run counts, judged on the route and the name lookup. A unit test pins the `runs` menu.

## [7.158]

### Fixed

- **"Which clients can I access?" lists them whichever operation it is routed to.** `rpi-admin` narrows the sub-agent's tools by operation, and the question was sometimes routed as `auth` (about 1 run in 5), whose menu had no client list, so the reply was the login settings. `get_user_client_list` is now in `auth` as well as `identity`. The router prompt is unchanged.

### Added

- **Routing scenario `admin-token-status`:** a token-validity check still calls `validate_token_status`, not the client list. A unit test pins the `identity` and `auth` menus.

## [7.157]

### Fixed

- **"Is my system healthy?" gets the availability check whichever operation it is routed to.** `rpi-health` narrows the sub-agent's tools by operation, and the question was sometimes routed as `overview` (about 1 run in 5), whose menu held only the monitoring overview. The availability getter (`get_system_health_availability`) is now in `overview` as well, and the skill says which to pick: up / healthy / any alerts → availability; the monitoring overview only when it is asked for. The router prompt is unchanged.

### Added

- **Routing scenario `health-monitoring-overview`:** an explicit monitoring-overview request still calls the overview, and not the availability check. A unit test pins both `rpi-health` menus.

## [7.156]

### Fixed

- **A sub-agent that repeats a tool call is told to stop, instead of the whole request failing.** The repeated-call guard answers a sub-agent's third identical tool call with a stop message instead of running the tool again. It returned that message as plain text, which the MCP tools' result conversion can't read ("result is not an Object"), so each time the guard tripped the skill dispatch failed and the user was told there was a "technical issue". Seen on "the result counts from the last run of my …" and "the workflow status of my …" interaction. The guard now returns the message as an MCP tool result, which the model reads like any other.

## [7.155]

### Security

- **hono 4.13.13 and the MCP SDK's runtime dependencies at their fixed releases, as on the server lines (RPI 7.226, DRH 7.215).** `apps/server`, `packages/mcp-rpi` and `packages/mcp-drh` declare hono 4.13.13 (was 4.12.25), and the root `overrides` add hono 4.13.13, fast-uri 3.1.9, qs 6.16.1, ip-address 10.7.4 and @hono/node-server 1.19.15 beside the zod 4.6.6, body-parser 2.4.0 and proxy-addr 2.0.8 this line already forced. Relocked: `bun audit` goes from 93 advisories (45 high) to 35 (18 high); the rest sit in the web build toolchain (nanoid, PostCSS, Browserslist, adm-zip, js-yaml 3 under gray-matter), which this change doesn't touch.
- The server lines also force js-yaml 4.3.2 and brace-expansion 2.1.7; this line can't. `packages/skills` reads SKILL.md front-matter through gray-matter, which calls js-yaml 3's `safeLoad` (removed in js-yaml 4: every skill failed to load), and minimatch 3 under eslint expects brace-expansion 1.
- The inline servers already carried zod 4.6.6, the `z.record` key schemas and the test without a real account name; their code is unchanged.

## [7.154]

### Fixed

- **A workflow run's log, or all of its activity results, is fetched instead of named.** `rpi-workflows` narrows the sub-agent's tools by operation, and the router picks the operation from the words in the request. "Get the run log for workflow-association instance …" was sometimes routed as `instance`, whose menu had no log tool, and "Get all the activity results for workflow run instance …" as `activity`, whose menu had no all-results tool. Either way the sub-agent told the user which tool to use and fetched nothing. The run-log getter (`get_workflow_association_instance_logs`) is now in `instance` as well as `logs`, and the all-results getter (`get_workflow_all_activity_results`) in `activity` as well as `instance`. The skill is the web line's (7.332), byte-identical.
- The router's catalog lists operation names only, so its text is unchanged: the router prompt is byte-identical before and after.

### Added

- **Two routing scenarios guard the wider menus:** `workflows-instance-all-activity-results` (all of a run's activity results → the all-results getter) and `workflows-instance-summaries` (a run's instance summaries still → `list_workflow_instance_summaries`, not the log tool). `workflows-activity-results` already holds a single-activity request to the single-activity getter. A unit test pins the `activity`, `instance` and `logs` menus.

## [7.153]

### Fixed

- **A Data Readiness Hub database, source or feed asked for by name is the one you get, not an invented one.** With no list tool in the `get` operation, a by-name question made the sub-agent invent an id (from the name's digits) and report the wrong record or "not found"; the subject-area getter was passed the name as its id. `drh-datasources`' `get` now also holds `drh_list_databases` and `drh_list_sources`, and `drh-feeds`' `get` holds `drh_list_feeds`. `drh-datasources`, `drh-feeds` and `drh-data-quality` now say a name is not an id: find it in the list tool's results, fetch by that id, and say it wasn't found if it isn't listed. Unit tests hold both `get` lists and the rule's text and place in each skill.

## [7.152]

### Fixed

- **A Data Readiness Hub database's consolidation rate and summary are reachable from any operation.** `drh-datasources`' `get` operation did not include the summary tools, so a "my default database" question routed to `get` could not read the consolidation rate and answered that it wasn't there. `get` now also holds `drh_get_database_summary`, `drh_get_database_cdp_summary` and `drh_get_database_consolidation_rate`. A unit test holds the list.

## [7.151]

### Fixed

- **Data Readiness Hub hygiene scores and match confidence look back far enough to find the history.** The DRH data-quality tools take `count` as a look-back window in days, not a number of records. The sub-agent sent a small count, so history a few months old came back empty ("no hygiene score history", "no match-confidence data") even when many runs existed. `skills/drh-data-quality/SKILL.md` now says `count` is days and to always pass it: the user's period when they name one, otherwise `count: 3650`. The routing eval now checks the tool call's arguments and rejects answers that claim the data is missing: `drh-op-hygiene-scores` is tightened, and `drh-op-hygiene-history` and `drh-op-match-confidence` are new. A unit test holds the skill's guidance.

## [7.149]

### Fixed

- The RPI and DRH executable zips' `.env.example` shipped `AUTH_REQUIRED=true`, so a server started from it demanded a bearer token and the account in the file was never used. The zips now ship `false` (service-credential mode, as the standalone servers' own templates do); the hosted app's `.env.example` keeps `true`. The value is set per scope in `scripts/env-scopes.ts`, and a test holds both.

## [7.148]

### Changed

- **The RPI and DRH MCP servers are current with their maintained source.** `packages/mcp-rpi` and `packages/mcp-drh` now carry the RPI MCP server 7.224 and the DRH MCP server 7.213 source, copied from the servers' own repositories. They bring the hardening those releases carry: loopback-only binding in the native-credentials mode, rate limits, per-owner idle-expiring sessions, request-size and upstream-response limits, a per-call audit line, the tool-surface count, user-scoped sessions, the tenant pin, the production serve mode and the version report, each with its tests. Two adjustments for this repository's layout: the servers find the repository-root `.env` three directories up, and one RPI test that inspects the servers' own container build is not included.
- `docs/architecture.md` and `docs/rpi-mcp-server.md`: the pinned Bun decides the trusted roots (every `oven/bun` stage at or above 1.4.4, held by `scripts/__tests__/pinned-bun.test.ts`); build binaries with Bun 1.4.4 or later.

## [7.147]

### Security

- **Next.js 16.4.1** (was 16.3.8): GHSA-2464 (image optimizer SVG handling, remote code execution), GHSA-673q (`use cache`, remote code execution) and CVE-2026-94482 (Server Actions denial of service). None is reachable in this app (the image optimizer is off, no `use cache`, no Server Actions), but the vulnerable code ships in the dependency. Only `next` and its own `@next/*` packages change; `sharp` stays 0.35.5.

## [7.146]

### Security

- **Bun 1.4.4 in every image: no compromised root in the trust store.** Bun carries its own CA bundle, and a binary it compiles carries that bundle too. Bun 1.3.12 still trusted emSign ECC Root CA - G3, which the Mozilla root store removed after the CA's signing key was compromised, so a certificate it signed could have impersonated the RPI or DRH API, or the model provider. Every `oven/bun` stage (the server image, the web image's builder, and the builders that compile the RPI and DRH MCP server binaries) is now `oven/bun:1.4.4`, pinned by digest: the first Bun whose bundle drops that root (emSign Root CA - G1 stays, as in Mozilla's store). `scripts/__tests__/pinned-bun.test.ts` holds every `oven/bun` stage, digest-pinned, at or above 1.4.4. A binary built on the host with `bun run build:all` carries the host Bun's bundle: build with Bun 1.4.4 or later.
- Bun 1.4.4 adopted as a documented exception to the 7-day minimumReleaseAge rule to remediate the eMudhra/emSign ECC Root CA G3 trust (active CA exposure); digest-pinned + full-test-gated.

## [7.145]

### Security

- **Node 22.23.4 in both images**, every Node image pinned by digest. The web image served from `node:22.12-alpine` and built Next.js with Node 22.12; the server image installed Debian's `nodejs` 20.19.2, a release line past its end of life. The server image now copies the official binary before `bun install` (better-sqlite3 is built for its ABI) and installs no `nodejs`. A test holds the Dockerfiles to it.
- **`@modelcontextprotocol/sdk` 1.32.0 with the tool-argument ceiling set**: GHSA-46jr-4wx8-v453 (CVE-2026-111768) and CVE-2026-111767. Both MCP servers (`packages/mcp-rpi`, `packages/mcp-drh`) set `maxToolInputElements` to 10,000, so a `tools/call` whose arguments are large enough to exhaust memory during validation is refused first. 1.32.0 is above GHSA-6qxp-vccf-f47h (CVE-2026-104850), fixed in 1.31.0.
- **Next.js 16.3.8**, the lowest release that clears every Next.js advisory open against 16.2.9. The web image runs `next build` under Node: Next 16.3's Turbopack build crashes under Bun.
- **The image optimizer is off** (`images.unoptimized`): `/_next/image` answers 404 before it fetches or decodes anything. The app uses no `next/image`.
- **The web proxy routes refuse a workspace id that leaves its server path**: only `[A-Za-z0-9_-]` ids reach the server; anything else gets 400 before an upstream call.
- **Dependency pins**: `sharp` 0.35.5 (GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w), `shell-quote` 1.11.0 (GHSA-pqg4-j6r4-53mv; not installed or shipped), `proxy-addr` 2.0.8 (GHSA-jqcg-44mw-7w3h).
- **A 7-day release-age wait for new dependency versions**: `bunfig.toml` `minimumReleaseAge` and a Dependabot cooldown.

### Changed

- The README's opening line describes RPI and DRH support and the Skill Router.

## [Unreleased]

### Added

- The Data Readiness Hub MCP server ships as a **standalone binary** for the agent-developer audience, mirroring the RPI release pipeline: `build:linux` / `build:windows` / `build:all` / `build:copy-templates` / `release:zip`, producing `rp-drh-mcp-<platform>_<version>.zip` with the binary, a per-OS launcher, `README.txt`, a quick-start and a working `.env`. Previously `mcp-drh` had a single `build:linux` that existed only to feed its Dockerfile, so the loose binary in `dist/` was a build byproduct rather than a deliverable.
- Both standalone zips now ship a **real, working `.env`** so an internal rep extracts and double-clicks with nothing to configure — the same posture as the docker bundle. It is *derived*, not copied: values are overlaid onto the key list in `.env.example`, so a dev-only secret that isn't documented there (`SEMGREP_APP_TOKEN`, for one) cannot ride along.
- Artifact names are now one family, so a rep with all three in a shared folder can tell them apart at a glance: `_rp-ai_web_docker-container_<ver>.zip` (full stack: `web` is the entity, `docker-container` the delivery form that distinguishes it from the standalone binaries), `_rp-rpi_mcp-server_<platform>_<ver>.zip` and `_rp-drh_mcp-server_<platform>_<ver>.zip`. Leading underscore top-sorts them together, `_`-separated segments, and one dotted version read from `packages/shared/version.json` — the docker bundle previously slugged it to `6-54`, which read as a different scheme from the binaries beside it.
- Standalone zip entries moved to the **zip root**. They were nested under a platform folder, so Windows "Extract All" produced a doubly-nested directory — the same problem the web bundle already fixed.
- Zip filenames carry the build (`..._6.53.zip`), read from the same `packages/shared/version.json` the web build and docker bundle use, so all three artifacts state one number. The binary inside keeps a stable name — the launchers and the Dockerfile `COPY` reference it, and an MCP client config pointing at the binary path would break on every bump.
- A single quick-start covering both servers ships in every zip: no macOS (that target is disabled in `build:all`, and the old doc advertised zips we never produced), no "extract to your Desktop", and a verify section built on the degraded `/health` — a rep reads `missing[]` and knows exactly which variable to set.


- Workspace cards show a single status line naming the exact reason a workspace isn't working, computed server-side as one enum in `runtime-status`: `not_configured` → `unauthorized` → `unreachable` → `no_tools` → `ok`. The order is deliberately not handshake order — `unreachable` is the catch-all for any probe failure and a 401 also fails the probe, so the specific signals must be tested first or the `unauthorized` branch is unreachable code. The server owns the classification and the card owns only the wording, so no string-matching on error text can drift into the UI. The card's `/health` lookup runs only on the unhappy path with a 1.5s slice of the existing budget rather than a second full fuse, and the line is fetched client-side after paint so a dead MCP server can never stall the landing page. Cards stay clickable in every state — disabling one would lock the user out of the Config tab, which is where the detail lives.


- `rpi-domain-expert` — a dispatched, grounded domain-knowledge expert for building RPI campaigns (attributes, selection rules (segments), audiences, interactions, and the design strategy behind them). Tool-less; its knowledge loads into a sub-agent only on a knowledge-intent hit.
- **SSO login via Keycloak (OIDC)** — the intended primary auth path: a NextAuth OIDC provider doing `authorization_code` + PKCE (S256) as a **public client** (no client secret). Configuration is **discovered, not hardcoded** — the realm issuer comes from the identity provider's public `openIDIssuer` advertised in `login-settings`, and NextAuth resolves authorize/token/jwks from that issuer's `.well-known`. The issued JWT is accepted directly by the backend and by the app-server OIDC branch. Login-hardening: **brand-free generic labels**, and credential fields render readonly-until-focus so the browser can't pre-fill across the stacked forms.

### Changed

- `docs/architecture.md` now documents configuration ownership — config comes from the seed plus the environment and nowhere else, the seed rewrites workspace config on every boot, the workspace set is enforced without ever deleting a row whose conversations cannot be reparented, and `provider.apiKey` accepts only `${ENV_VAR}` indirection. Written as a property that holds across all six generations, not a seventh: it is not a tool-exposure generation and must not imply a MAJOR bump. Also corrects the component diagram, which advertised "CRUD for workspace configs" when create and update are no longer supported surfaces.
- Documentation corrected ahead of the OSS publish: the `skills/templates/` sections are removed (the directory never existed, and a workspace created from those `curl` examples would be reaped on the next boot as unexpected); docs no longer coach a literal `provider.apiKey`, which the schema now rejects; the retired single-"RedpointAI"-workspace and create-workspace narratives are replaced with the two seeded product workspaces; `deployment.md` no longer documents the removed `DRH_API_URL` seeding gate; skill counts corrected to 15 (11 action, 4 experts); and the build-version path points at `packages/shared/version.json`.


- **Product naming corrected throughout the UI.** RedpointAI is the parent platform; the products are **Redpoint Interaction (RPI)** and **Data Readiness Hub (DRH)** — the nickname "DR Hub" is retired. The seeded workspaces are renamed accordingly, and an existing database is migrated **in place** on boot (rows are renamed, not re-inserted, so history stays attached and nobody ends up with duplicate cards). Canonical names now live in one place, `WORKSPACE_NAMES` in `@redpoint-ai/shared`, consumed by both the seed and the integration suite.
- Landing page header now mirrors the workspace-page header exactly (same element, padding, bottom rule and title type), so the two line up at identical height and the rule doesn't jump when moving between them; it also picks up the theme toggle it previously lacked.
- Workspace cards moved the provider out of the title row into a footer strip reading `<model> on <provider>`, so the header carries the product alone and the runtime detail is anchored rather than floating.
- The landing header shows the build number, so the first question on a support call is answerable without opening the Config tab.
- Landing, workspace headers, page metadata and workspace cards reworded brand-first: "Redpoint Global · Agentic AI Platform" at the platform level and "Redpoint Global · AI Agent for RPI" inside a workspace; cards title as "Redpoint Interaction (RPI)".
- Skill router now supports **dispatched experts** (`dispatch: true` on an `expert` skill): such an expert is surfaced in the catalog and reached via `execute_skill` instead of being inlined into the router prompt, so its body costs the parent prompt nothing until invoked.

### Changed

- `bun run build:bundle` now prunes older `rp-ai-*` image tags on the build machine after a successful build, keeping only the version it just built. Each build tags four more images and nothing swept them there — the launcher's prune only runs on the machine running the bundle — so nine builds had grown to 36 images (~90 GB). Rep machines were never affected; they stay at exactly four. Nothing is lost, since any prior version reloads from its own zip.

### Removed

- The admin panel (`/admin`, `/admin/providers`) and its header button. Both pages duplicated the workspace Config tab: the providers page rendered the same `listProviders()` payload the Config tab already shows under **Provider availability** (configured dot plus the missing environment variable), and the health card's version is the Config tab's **Build** row — leaving only `status: "ok"` and a hardcoded `runtime: "bun"` as unique content. One less surface to keep honest; it was the page claiming to "manage AI provider configurations and API keys" while having no inputs. The server-side `/api/v1/providers` endpoint and `listProviders()` stay — `runtime-status` depends on the function.

### Fixed

- `mcp-drh` had no boot-time configuration detection at all, so an unconfigured Data Readiness Hub was indistinguishable from an unreachable one — the orchestrator could not tell "nobody set this up" from "the server is down", which are different answers on a workspace card. It now builds a missing-variable list at boot and reports it on `/health` in the same shape `mcp-rpi` already used (`mcp: "degraded"`, `reason`, `missing[]`), so a caller reads either server's state without per-product branching. The required set is derived from the config contract rather than invented: `DRH_DEFAULT_DATABASE_ID` is excluded because the schema declares it optional, and the proxy credentials are required only when the proxy is enabled — listing them unconditionally would report a variable the operator deliberately left unset.
- A contradictory proxy configuration (`DRH_PROXY_ENABLED=true` with no credentials) took the `mcp-drh` container down at boot: `resolveProxyEnabled()` throws and both the new detection and `loadDrhConfigFromEnv()` called it unguarded. A dead container reports as "unreachable", which is a worse diagnostic than naming the variable that is actually missing, so the throw is now caught and treated as the degraded signal it is.


- `bun run test:accuracy-evaluation` could not load. `tests/integration/helpers.ts` and `routing.test.ts` imported `WORKSPACE_NAMES` from `@redpoint-ai/shared`, but `tests/` is not a workspace package so the alias does not resolve there — the neighbouring `import type` from the same package had always worked only because type imports are erased before runtime. The routing suite therefore failed at import for an entire release stretch while `bun run test` stayed green, because that suite never reaches `tests/integration/`. Now imported relatively, matching the file's existing cross-package imports, and the coverage gap is called out in `CLAUDE.md` and `tests/integration/README.md`.


- Loading a workspace's MCP tools is now bounded (10s) in the chat, AG-UI and tools-listing routes. The previous fix guarded the *error* path but never the *wait*: an unreachable MCP server does not fail fast, it stalls behind the transport's own long timeout, so a chat request simply never returned — measured at over 90 seconds against a stopped container. Turning a 500 into an indefinite spinner is worse than the 500. All three paths now degrade to `503 mcp_unavailable` within 10s; a healthy workspace is unaffected (1.4s).


- RPI lifecycle tools violated the transport timeout invariant. `patched-transport.ts` requires `tool 220s < transport 240s < Bun idleTimeout 255s`, but `run_audience_test_workflow` and `run_interaction_workflow` defaulted to 300s — so a long run was killed mid-flight by the transport instead of returning a clean tool timeout. Both lowered to 220. **One narrow behavior change:** a workflow finishing between 220s and 240s previously succeeded and will now return a tool timeout — anything past 240s was already being aborted mid-flight. If a workflow that used to complete starts timing out, that band is the first thing to check; pass a larger `timeoutSeconds` only knowing the transport still aborts at ~240s, with the invariant spelled out at each constant. The tool descriptions and the `rpi-audiences` / `rpi-selection-rules` skill bodies repeated the old "5 min" figure to the model and were corrected too; the "matches Java RPI-MCPServer" claim is dropped where we now deliberately diverge, so nobody "restores parity" and re-breaks it.
- `skills-load.test.ts` asserted only that *some* skills loaded. `loadSkillsFromDirectory()` logs and skips a malformed `SKILL.md`, so a broken file was silently dropped while the suite stayed green — 9 of the 15 shipped skills had no assertion anywhere. It now asserts the exact shipped set by name, so both a vanished skill and an undeclared new one fail.


- The seed's workspace reaper could **destroy conversations**. `threads → workspaces` is `onDelete: "cascade"` (and messages/runs cascade off threads), but the delete ran outside the `if (keepId)` guard — so a row it couldn't reparent lost its threads and messages permanently rather than being left orphaned. It is now left in place, with a warning: an extra card is visible and recoverable, deleted messages are neither.
- `routes/agui.ts` carried its own copy of the skill-registry singleton that assigned the registry *before* awaiting the skill load — the exact race `skills/registry-singleton.ts` was written to fix. A second caller during boot saw a truthy-but-empty registry, and because the registry (not the promise) was cached, the degradation was permanent for the process. It now imports the shared singleton.
- The root `docker-compose.yml` never set `DRH_MCP_URL` for the server, so the seed fell back to `localhost:3003` — the server container's own loopback. The Data Readiness Hub workspace could not connect under root compose even when DRH was fully configured; the bundle compose had always set it.
- An unreachable MCP server made chat return **500**. `getToolsForWorkspace()` was awaited unguarded in the chat, AG-UI and tools-listing routes. All three now degrade — and **surface** the failure (503 with an explicit `mcp_unavailable` message) rather than continuing with an empty tool map, which would produce an agent that looks healthy while silently missing the tools it advertises.


- A missing or typo'd `DRH_API_URL` no longer destroys data. The Data Readiness Hub workspace was added to the seed's expected set only when that variable was present, so an absent one made the workspace "unexpected": the reaper reparented its conversations into Redpoint Interaction and deleted the row — a data event triggered by a missing environment variable, which is what a transient Key Vault hiccup looks like at boot. Both product workspaces are now always seeded and always expected, so an unconfigured backend is a display concern rather than a data one, and both cards always render. Provisioning conditions decide whether a workspace is *created*, never whether an existing one is destroyed.
- The Data Readiness Hub accuracy gate no longer uses workspace absence as its skip signal. With the workspace now always seeded, absence never happens, so those scenarios would have started running against an unconfigured backend. It gates on a real signal instead — a reachable MCP connection exposing tools, read from the server rather than the test runner's own environment.


- Configuration now has exactly one story: **code (the seed) plus the environment** — `.env` for OSS, key vault when hosted. The workspace settings UI has been removed; it wrote provider/agent/MCP/skills/suggestions straight into the `workspaces` row, and its provider form accepted a literal `apiKey` that `createModelFromConfig()` prefers over `process.env` — so a pasted key landed in plaintext SQLite (and in the docker bundle's `server-data` volume), silently shadowing the configured environment. The workspace config schema now accepts an `apiKey` only as `${ENV_VAR}` indirection.
- The seed is authoritative for the Redpoint Interaction workspace and rewrites its config on every boot, matching what the Data Readiness Hub workspace already did. This also fixes upgrades: `DEFAULT_WORKSPACES` is only inserted into an *empty* database, so an existing install kept whatever it was first seeded with — one created before `rpi-domain-expert` shipped would never have received it, and one left holding only expert skills has no `execute_skill` tool at all, quietly dropping the router to category-discovery.
- `AZURE_OPENAI_DEPLOYMENT_ID` is finally wired. It shipped in `.env`, in the bundle `.env` and in the compose file, but nothing read it at runtime — an operator could repoint it, restart, and see no change, because the model lived in the workspace row. `pickDefaultProvider()` now honours it (plus `AZURE_OPENAI_MODEL` / `ANTHROPIC_MODEL` / `OPENAI_MODEL`), and since the provider block is re-derived each boot, editing `.env` and restarting is all it takes.
- Admin → Providers no longer claims to "manage AI provider configurations and API keys"; the page is read-only status derived from the environment, and now says so.

- The seed now **enforces** the workspace set rather than assuming it: after seeding, any row outside the seeded products is removed and same-name duplicates collapse to the oldest (the row history is attached to). Threads, API keys and audit rows are moved to the survivor first, so healing never costs a conversation. This closes the downgrade-then-upgrade hole — running a build that predates the rename re-inserted a legacy workspace, and the previous migration skipped it, stranding a permanent extra card. The expected set is derived from the seed definitions, so adding a product raises the ceiling without touching the enforcement code. Safe because workspaces are created only by the seed; the product gives users no way to add one.

- The Data Readiness Hub routing gate resolved its workspace by the literal name `"DR Hub"`. Because the block is `describe.skipIf(...)`, the workspace rename would have made that lookup return null and the entire gate would have **skipped green** — a release check that silently tested nothing. Both it and the accuracy-evaluation benchmark now import the canonical names instead of hardcoding them.
- The "Connect RPI" header control now appears only in workspaces that actually use the RPI MCP server. It previously rendered on every workspace page, so the DR Hub workspace showed an RPI-specific sign-in affordance. The check reads the workspace's MCP connections (`config.mcp`) rather than its name.
- Prebuilt docker-container bundle: the double-click launcher (`start_redpoint-ai.bat`) now prunes orphaned old-version `rp-ai-*` images on every launch, so repeated or upgraded runs no longer pile up a fresh set of four images in Docker Desktop. The image load itself is still skipped when the current version is already present (fast restarts).
- Prebuilt docker-container bundle: dropped the `mcp-rpi` / `mcp-drh` container healthchecks. Their probe shelled out to `bun`, which the slimmed `debian:12-slim` runtime images don't carry, so both showed a spurious `unhealthy` in Docker Desktop even though they serve `/health` fine. Nothing depended on those healthchecks (only `web` waits on `server`), and process liveness is unaffected — a crashed server still exits its container. The bundle quickstart and launcher wording now say the services are "running" rather than "healthy," matching what Docker shows for the two unchecked MCP containers.

---

<!-- Compare link — update <<ORG>>/<<REPO>> once the canonical slug is locked -->
[Unreleased]: https://github.com/<<ORG>>/<<REPO>>/compare/HEAD...HEAD
