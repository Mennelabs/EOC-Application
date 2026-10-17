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

| Task | What                                                                                                                                                                                                               | State | Commits                       | Notes                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| P    | Decision recorded; this status file; `trace-layer8.json` wired into the traceability build                                                                                                                         | done  | ba2428e                       |                                                                                                   |
| A    | Resource requests to the state (ICS 213 RR): tables, actions, templates, API (draft, lines, submit, approve by a second person, place, status, cancel, receive, raise from a supply request), seed, database tests | done  | 2cfcb58                       | CON-13 partial; the screen (A2), the PDF (B) and the state API (E) follow.                        |
| A2   | Resource requests console screen, navigation entry, journey with axe                                                                                                                                               | done  | 8912ab0                       | In the GATE-03 every-screen scan.                                                                 |
| B    | ICS forms as documents: objectives (202), general messages (213), form model and editions, tagged PDF and CSV, issue snapshots, screen                                                                             | done  | b0a4e7e                       | Editions ship in code (forms.ts), not as county-editable mappings; see open items.                |
| B2   | ICS forms console screen: objectives, general messages, pick a form and scope, preview, issue, download; navigation; scan                                                                                          | done  | e5c3fb6                       | In the GATE-03 every-screen scan.                                                                 |
| C    | Wall briefing display (CON-11): display role, aggregate payload without personal fields, full-screen view, refresh                                                                                                 | done  | 3cdcc18                       | The wall shows live conditions once task D fills them.                                            |
| D    | Live conditions (CON-14): sources and conditions, WZDx and Waze receive connectors, staff override, routing container, map layer and list                                                                          | done  | 7306c29                       | D1 feeds and API; D2 screen and map; D3 routing. CON-14 partial until closures weight the router. |
| D2   | Live conditions console screen (list with source and age, sources and their health, staff entry), map legend entry, scan                                                                                           | done  | 049e476                       | In the GATE-03 every-screen scan.                                                                 |
| D3   | Self-hosted routing container (OSRM from the OpenStreetMap extract) behind compose profile `routing`, a route and travel-time API                                                                                  | done  | 5d0ef98                       | ADR-0046; opt-in profiles like maps.                                                              |
| E    | State read API and webhooks (CON-13, SCL-09): `eoc.read` scope, state callbacks, new webhook events                                                                                                                | done  | b0dc436                       | Direct WebEOC writes stay per state on request (question 3).                                      |
| F    | Retention, gates, accessibility records, traceability, the layer-8 report, README                                                                                                                                  | done  | (next commit records the SHA) | Report in layer-8-report.md; gates in layer-8-gates.md.                                           |

## Open items

- Layer 8 is built (tasks P to F); the report is `docs/plans/layer-8-report.md` and waits on Adam's review with layer 7's. Follow-ups listed there: a shorter retention sweep for cleared live conditions, county-editable ICS editions, closures weighted into routing, and the per-state WebEOC adapter.

- Layer 7's formal approval is deferred (Adam, 2026-10-17); its report and questions stay in `docs/plans/layer-7-report.md`.
- The ICS form editions (block numbers and labels of the 201, 213, 213 RR, 214 and 309) ship in code (`packages/reporting/src/ics/forms.ts`), named on every form, and must be compared with fema.gov before release; this environment cannot reach fema.gov (the same gap as DCL:DEC-12). The plan's county-editable form mapping (as the FEMA forms have) is not built: a new edition is a code change until Adam asks for mappings.
- A general message is "sent" when handed over; sending to phones goes through Messages to the field, and the field message can be linked on the general message (`fieldMessageId`).
