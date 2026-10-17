# Layer 8 status: ICS forms and EOC functions

Resume record for layer 8. Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then the plan [`layer-8.md`](layer-8.md) and `docs/decisions.md` (the 2026-10-17 row: layer 8 starts with layer 7's formal approval deferred; the plan's §13 questions run on their recommended defaults behind configuration until Adam answers).
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name && pnpm check:traceability`. Do not build on a red tree.
3. Work the tasks below in order, one per commit, each ending green, pushed and recorded here. Evidence goes in `tools/reqindex/trace-layer8.json`; regenerate `docs/traceability.md` with `python3 tools/reqindex/traceability.py`.
4. Local Docker was stopped on 2026-10-16 and is not restarted in this environment: the database and browser suites run in CI only. Unit tests, builds, the design showcase and `tools/preview/*` run locally.

## Defaults in force (plan §13, until Adam answers)

| Question | Default in force                                                                                    | Where it is switched                                |
| -------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 2        | Self-hosted routing from the OpenStreetMap extract; no Google Maps Platform                         | compose profile `routing` (task D)                  |
| 3        | A read API and webhooks the state pulls from; no direct WebEOC writes                               | API key scopes (task E)                             |
| 4        | A display account with `briefing.read` only, signed in on the wall's device                         | role template `briefing_display` (task C)           |
| 5        | A second person approves a resource request as section chief; finance need not reply before placing | tenant config `resource_requests.finance_threshold` |
| 6        | WZDx first, a state 511 feed where free                                                             | `cg.live_source` per county (task D)                |

## Tasks

| Task | What                                                                                                                                                                                                               | State       | Commits | Notes                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------- | -------------------------------------------------------------------------- |
| P    | Decision recorded; this status file; `trace-layer8.json` wired into the traceability build                                                                                                                         | done        | ba2428e |                                                                            |
| A    | Resource requests to the state (ICS 213 RR): tables, actions, templates, API (draft, lines, submit, approve by a second person, place, status, cancel, receive, raise from a supply request), seed, database tests | done        | 2cfcb58 | CON-13 partial; the screen (A2), the PDF (B) and the state API (E) follow. |
| A2   | Resource requests console screen, navigation entry, journey with axe                                                                                                                                               | not started |         |                                                                            |
| B    | ICS forms as documents: objectives (202), general messages (213), form model and editions, tagged PDF and CSV, issue snapshots, screen                                                                             | not started |         |                                                                            |
| C    | Wall briefing display (CON-11): display role, aggregate payload without personal fields, full-screen view, refresh                                                                                                 | not started |         |                                                                            |
| D    | Live conditions (CON-14): sources and conditions, WZDx and Waze receive connectors, staff override, routing container, map layer and list                                                                          | not started |         |                                                                            |
| E    | State read API and webhooks (CON-13, SCL-09): `eoc.read` scope, state callbacks, new webhook events                                                                                                                | not started |         |                                                                            |
| F    | Retention, gates, accessibility records, traceability, the layer-8 report, README                                                                                                                                  | not started |         |                                                                            |

## Open items

- Layer 7's formal approval is deferred (Adam, 2026-10-17); its report and questions stay in `docs/plans/layer-7-report.md`.
- The ICS form editions (213 RR block numbers, 201, 214, 309) must be compared with fema.gov before release; this environment cannot reach fema.gov (the same gap as DCL:DEC-12).
