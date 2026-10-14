# Layer 6 status: FEMA package and official reports

Resume record for layer 6. Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then `docs/decisions.md` (the 2026-10-14 rows: layer 6 starts; reference data pulled from free federal sources as well as imported, ADR-0039).
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name`. Do not build on a red tree.
3. The plan is [`layer-6.md`](layer-6.md). Work the tasks below in order, one per commit, each ending green, pushed and recorded here.

## Scope (what layer 6 is)

- FEMA's own damage-assessment formats and the data parts of the governor's request (Form 010-0-13), built from approved, verified records plus public reference data; never filed by the platform (DCL:DEC-05–17).
- Situation reports and briefings: drafted, reviewed, issued, frozen as snapshots, corrected by amendment (F15, RULE-10, RPT-01).
- Shared metric definitions, metrics and exports that agree everywhere (F14, MET, GATE-07).
- The equity dashboard and reporting-coverage alerts (EQ-11/12, CON-07).
- Reference data from free federal sources with file import for every dataset (ADR-0039, SCL-09).

## What already exists

- Reports with review state, verification level, FEMA degree, primary residence and pre-existing damage; versions and review decisions (layer 2). The intake graph already maps answers to FEMA fields (`femaMapping` in `packages/intake/src/engine.ts`, unused so far).
- Field assessments including a `validation` mode (layer 4); needs, partner claims, sites, shelter stays, service logs, stock, debris tickets, check-ins (layers 3–4).
- `governed_definition` (versioned definitions, unused so far), `tenant_config`, `jurisdiction` (table only), `event.footprint` (empty in the seed), `parcel` with unit counts (the only structure inventory today).
- Not yet: census tracts anywhere, reference data, official reports, form mappings, outage log, casualties, Public Assistance sites, a PDF library, a formula guard on CSV exports, object lock on snapshots.

## Tasks

| Task | What                                                                                                                                       | State | Commits              | Notes                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------- | ------------------------------------------------------------------ |
| P    | Plan `layer-6.md`; ADR-0039 accepted; decision log                                                                                         | done  | this commit          | Goes in with Mennelabs/EOC-Application#9                           |
| Fix  | Enclave API answered some writes before their commit (CI flake on #9); replies now leave after the commit, with a guard test for both APIs | done  | this commit          | FR-00.05/06, GATE-05                                               |
| Fix2 | Enclave sign-in e2e timed out about 1 in 12 (CI on #10): test workers starved each other of one-time codes; they now share tokens          | done  | `921583d`, `3bc8df5` | GATE-05, SEC-12                                                    |
| A    | Reference data foundation (snapshots, connectors, egress allowlist, import, recorded responses, schedules, admin API)                      | done  | `ccf8c9b`, `0b23f13` | GeoPackage and Shapefile import move to B; the screen lands with B |
| B    | Federal connectors (Census ACS and TIGERweb, NSI and USA Structures, NFHL, OpenFEMA, NRI/SVI, CMS, NWS, ODIN)                              | todo  |                      |                                                                    |
| C    | Geography and the counting rule; seeded synthetic reports; situation-map approved-state fix                                                | todo  |                      |                                                                    |
| D    | Declaration data: incident period, outage log, casualties, PA sites, FL-17 credit, DEC-17 field capture                                    | todo  |                      |                                                                    |
| E    | Official reports: drafts, review, issue, snapshots with object lock, amendments, what changed                                              | todo  |                      |                                                                    |
| F    | FEMA outputs: ADR-0040 (PDF), form mappings, forms, IDA package, exports, liaison view, joint assessment                                   | todo  |                      |                                                                    |
| G    | Metrics and equity: definitions, engine, screens, alerts, CSV (formula guard incl. `/needs.csv`)                                           | todo  |                      |                                                                    |
| H    | SCL-09 outbound: API keys, webhooks, feature-service endpoint                                                                              | todo  |                      |                                                                    |
| I    | Resident export (FL:FR-32) and media sheet PDF (PUB-13)                                                                                    | todo  |                      |                                                                    |
| J    | Tests and CI: stack suite, browser journeys with axe, veraPDF, load profile                                                                | todo  |                      |                                                                    |
| K    | Docs: ADRs, architecture, traceability, report, README, accessibility records                                                              | todo  |                      |                                                                    |

## Verified by (task P)

- Requirements read from the index (52 IDs assigned to layer 6) plus the IDs earlier plans parked here; `docs/05` mappings; Sections 19, 20, 21, 29 and 30; F14, F15, D05, D14, BP-04 and the decision register; the existing schema and routes (summary in the plan).
- Free sources checked on the web on 2026-10-14 (ADR-0039 lists them with their access terms); HIFLD Open is gone (August 2025), so critical facilities come from CMS and OpenStreetMap.

## Verified by (fix before task A)

- CI on #9 (`f572cdd`) failed in `services/cjis-api/test/api.db.test.ts`: recording an account's screening right after creating it answered 404, and activation then 409. Seven enclave routes (account create, permission request, audit review, legal hold, record create, record entries) called `reply.send` inside `request.tx(...)`, so the 201 could reach the client before the commit; the client's next request then found no row. Reproduced locally once in about 60 runs. The routes now return from the transaction and answer afterwards; the platform API already did. `services/cjis-api/test/reply-after-commit.test.ts` fails on the old routes (all seven found) and passes now, for both APIs; the enclave database and API suites passed 10 of 10 runs.

## Verified by (fix 2: enclave e2e timeouts)

- `cjis.spec.ts:139` repeated 12 times on two workers: 11 passed and one timed out at 240 s with no page activity. Instrumented, the stuck worker spent the whole budget waiting for a one-time code: an account can use one code per 30 seconds, each repeat starts a fresh worker, and the waiting worker lost the race for the next code to the new one eight windows running (Keycloak logged no failures). On CI the same wait ran the budget down until the passkey sign-in step. The harness now shares the tokens themselves between test processes under the lock (reused while fresh, refreshed, a new code only when neither works): 12 of 12 passed in 1.9 minutes, and the whole enclave file passed on both projects.

## Verified by (task A)

- Migration 0042 (amended before merge: upload state, client id, columns; a pruned snapshot clears its import's link) applied to the compose database, and the fresh-database drill passed (126 tables, nothing undocumented, every table under RLS; down three and up again).
- `packages/refdata`: dataset checks, egress allowlist and key redaction, retries, recorded responses, CSV and GeoJSON import, import fields for the wizard (14 tests); the OpenFEMA declarations connector against its recorded synthetic WESTWIND response, the geography it sends and its refusal outside its hosts (6 tests); snapshots and pulls against the database (6 tests).
- `services/worker/test/refdata.db.test.ts` (6 tests): geography from jurisdiction, city, state or configuration; schedule queues one pull and none without geography; pull audited, a source that is down leaves the last good snapshot; pulls off or import-only; import validated by row and field then applied; pruning keeps current and cited snapshots and honours a legal hold.
- `services/api/test/refdata.db.test.ts` (4 tests): sources and snapshots for the GIS lead and director, not for a coordinator; pull now (staff only, audited); upload, mapping and apply with idempotent create, If-Match, mapping errors named by field, apply only after a passed check, every step audited; bad GeoJSON refused, unknown import 404.
- `packages/config/test/worker.test.ts`: recorded mode refused in production mode (SCL-12); host list narrowing.
- The rebuilt stack pulled the recorded declarations for the county, the city and (after the fix below) the state and region tenants. Found and fixed on the way: a state's geography listed a county code once per county tenant sharing it; codes are now distinct (regression test added).
- All database suites as CI runs them, plus the new ones: green (two layer-4 suites need the reports that CI's integration step files first; they pass once those exist).

## Known issues and open items

- Questions for Adam with defaults in force: `layer-6.md` §14 (case management as layer 6b, reporting periods, equity thresholds, the Census key, FEMA validator accounts).
- Reference data in this layer so far: one connector (OpenFEMA declarations, pulled forward from B to prove the pipeline); the rest come in task B with their recorded responses. A pull already queued but lost (for example consumed by an older worker without the topic) is retried by the schedule after an hour.
- This build environment's network policy blocks the federal hosts (`api.census.gov`, `tigerweb.geo.census.gov`, `www.fema.gov`, `hazards.fema.gov`, `nsi.sec.usace.army.mil`, `api.weather.gov`, `odin.ornl.gov`); connectors are built against recorded synthetic responses, and live smoke tests need those hosts allowed.
- FEMA's current form versions could not be fetched (fema.gov blocked here); v1 mappings follow `docs/05` and must be compared with fema.gov/pda before the pilot (DEC-15).
- `CLAUDE.md` cites "DEC-17" for "federal forms only"; the source is `docs/05` ("No state mapping for the first pilot") and DCL:DEC-12. Reading in the plan: federal outputs only, mapping open to a state template later.
