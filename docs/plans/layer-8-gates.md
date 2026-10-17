# Layer 8 launch-gate evidence

Task F, 2026-10-17. The launch gates that apply to layer 8 (GATE-02, 03, 04, 07 and 09; layer-8 status row F) and the evidence for each. Every suite named here runs in CI on every push (`.github/workflows/ci.yml`), and the layer merges only when CI is green.

## GATE-02: released feature acceptance cases pass

The layer's acceptance cases are the requirement IDs in `docs/traceability.md` whose evidence is in `tools/reqindex/trace-layer8.json` (CON-11, CON-13, CON-14, SCL-09, and the earlier rows layer 8 extends). Each row names its tests:

- **Database suites** in `services/api/test`: `resource-requests`, `ics-forms`, `briefing`, `live-conditions`, `eoc-api`, and `authz-sweep` (which now reaches every new staff route); in `services/worker/test`: `live` (feed pulls).
- **Unit suites:** `packages/reporting/test/ics.test.ts` (form models, CSV, PDF model, hash), `packages/refdata/test/live.test.ts` (feed parsers), `services/api/test/routing.test.ts` (OSRM client and the straight-line fallback), `packages/authz/test/templates.test.ts` (who approves, places, issues, reads the wall).
- **Browser scan** on desktop and phone: `tests/e2e/console-screens.spec.ts` opens Resource requests, ICS forms (with a 201 preview), Live conditions and the Wall display with axe (WCAG 2.2 AA) and the reflow check.
- **veraPDF:** one sample of each ICS form (201, 213, 213 RR, 214, 309) is checked as PDF/UA-1 in CI with the other PDF kinds (NFR-12).

Partial rows (CON-13, CON-14) are listed with their gaps in the layer-8 report.

## GATE-03: accessibility evidence for released public tasks

Layer 8 adds no public task. Every layer-8 staff screen has a record in `docs/a11y/screens/`: `resource-requests.md`, `ics-forms.md`, `wall-display.md` and `live-conditions.md`, listed in `docs/a11y/checklist.md`. axe with WCAG 2.2 AA rules runs on each screen on desktop and at phone width, with the reflow check; the wall display is also checked in briefing mode (navigation hidden, large type).

**Open:** the screen-reader pass (check 2 on each record) needs a person with NVDA and VoiceOver; the wall display also wants a check on the wall itself at its real distance and size.

## GATE-04: no known unauthorized-access bypass

- **Every staff route, both callers.** `services/api/test/authz-sweep.db.test.ts` calls every route under `/api/v1`, now including resource requests, incident objectives, general messages, ICS forms, the briefing, live conditions and sources, and routing: without a token and as an account holding no role, neither ever succeeds or hits a server error.
- **The key-served API.** `/api/eoc/...` is not under `/api/v1`; `eoc-api.db.test.ts` proves that no key, a key of another scope, a pending key and an expired key are all refused the same way, that an unknown event is not found, and that the update scope cannot read and the read scope cannot update.
- **Per-feature permission cases in layer 8:**

| Feature           | What is proven                                                                                                                                                                                                                                        | Test                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Resource requests | The submitter never approves (by grant and by the engine, ADM-05 G4); only the director holds approve; logistics places; a reader may not draft, submit or place; the PIO has no part; finance's reply gates placing when the county sets a threshold | `resource-requests.db.test.ts`, `templates.test.ts` |
| ICS forms         | A general message is approved by a second person, never its writer; the PIO reads objectives and nothing else; issuing is explicit and the administrator does not hold it; downloads are audited with their scope (SEC-18)                            | `ics-forms.db.test.ts`, `templates.test.ts`         |
| Wall display      | The display role reads the briefing and nothing else (reports, needs and accounts refused); a role without `briefing.read` gets not found; the payload carries no personal key or content                                                             | `briefing.db.test.ts`, `templates.test.ts`          |
| Live conditions   | Only those who manage feeds add, change or import; a feed item is never cleared by hand; the PIO reads and never writes; a nurse sees nothing                                                                                                         | `live-conditions.db.test.ts`                        |
| State API         | Reads by scope, every use audited under the key; callbacks by a separate scope, each a step by the key, refused backwards; keys and webhooks keep the second-administrator approval (0051)                                                            | `eoc-api.db.test.ts`                                |

## GATE-07: one figure, many places

The wall briefing's counts come from the same tables the dashboard and the situation map read (`cg.report` by review state and FEMA degree, `cg.need` by status, `cg.mission` by state, `cg.site` for shelters): `briefing.db.test.ts` seeds a shelter, an objective and a log entry and reads them back as counted. The ICS 201's objectives are the same rows the objectives panel and the wall list (`ics-forms.db.test.ts` reads block 7 back as entered). Totals on the ICS 213 RR are the request's own lines (`ics.test.ts`).

## GATE-09: backup and restore cover the new tables

`scripts/backup.sh` dumps the whole `cg` schema and `scripts/restore.sh` brings it back; the layer-8 tables (`resource_request`, `resource_request_line`, `resource_request_step`, `incident_objective`, `general_message`, `ics_form_issue`, `live_source`, `live_condition`) are ordinary tables in that schema with their rows in the data dictionary (SEC-11, migrations 0107–0110), so a restore carries them with everything else. The audit chain heads recorded at backup time cover the audit rows these features write.

**Retention (SEC-13):** the new tables fall under the default `records` category (kept with the event, default seven years, legal holds override). Cleared live conditions and lapsed feed items are kept under the same rule; a shorter sweep for them is listed as a follow-up in the layer-8 report.
