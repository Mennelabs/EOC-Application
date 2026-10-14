# Layer 5 status: CJIS enclave

Resume record for layer 5. Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then `docs/decisions.md` (the 2026-10-13 row that starts layer 5).
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name` on `main` (layer 4 merged in Mennelabs/EOC-Application#7, `4e58689`). Do not build on a red tree.
3. First task is the plan, `docs/plans/layer-5.md`, before any code (CLAUDE.md rule 5).

## Scope (what layer 5 is)

- **SEC-12:** criminal-justice information (law-enforcement mission fields, suspect and other law-enforcement roles in people involved, weapons, arrest dispositions, bodycam references) is stored only in the enclave: its own network boundary, database, keys, identity with its own MFA, audit and personnel screening, to FBI CJIS Security Policy v6.x.
- **PPL-01:** the law-enforcement roles and details of people involved live in the enclave; layer 4 deferred them here.
- **ADM-05:** criminal-justice data only for CJIS-qualified users; no county can configure that away.
- **SEC-13:** CJIS data follows CJIS and state records rules for retention.
- **SCL-12 and CLAUDE.md rule 2:** the enclave is its own container set and holds only synthetic data until it is in an authorized government cloud and has passed the state CJIS audit.
- **Not in scope:** CAD, NCIC or records-system integrations (INT-07, separately approved contracts only); 911 telephony or CAD replacement.

## What already exists (layer 1)

- The `cjis-api`, `cjis-db` (PostGIS), `cjis-keys` and `cjis-keys-init` (OpenBao) services in `compose.cjis.yaml` (included from `compose.yaml`) on their own `cjis` network, unreachable from the platform network (ADR-0021; tested in `tests/integration/stack.int.test.ts`).
- `services/cjis-api` is a skeleton (`src/main.ts`) with health checks only.
- Missions and their people involved (`services/api/src/routes/missions.ts`) exist without any law-enforcement fields; nothing criminal-justice is stored anywhere yet. How the platform mission refers to its enclave record is a plan decision.

## Carried over from layer 4 (not layer 5 work unless Adam says so)

See `docs/plans/layer-4-report.md`, "What did not pass, or is not yet proven" item 5 and "Decisions needed from you". The open defaults are in force.

## Tasks

Plan: [`layer-5.md`](layer-5.md). One task per commit; each ends green, pushed, and recorded here.

| Task | What                                                                                                        | State | Commits | Notes |
| ---- | ----------------------------------------------------------------------------------------------------------- | ----- | ------- | ----- |
| P    | Plan `docs/plans/layer-5.md`                                                                                | done  | 3335213 |       |
| A    | Enclave containers and identity (`cjis-idp`, `cjis-provision`, `cjis-web`, `cjis-gateway`, secrets, guard)  | done  | d0b21df |       |
| B    | Enclave database `packages/cjis-db` (migrations, dictionary, RLS, audit chain, retention, synthetic agency) | done  | 7a30a0a |       |
| C    | Enclave API (auth, qualification, policy, audit, encryption, routes, jobs)                                  | done  | 435f204 |       |
| D    | Platform side (migration 0041, actions, template, mission routes, seed liaison, dictionary guard)           | done  | 5310f2b |       |
| E    | Enclave web app `apps/web-cjis`                                                                             | done  | 168ad5d |       |
| F    | Console CJIS panel and link action                                                                          | done  | this commit |       |
| G    | Tests and CI (stack suite, browser journeys, enclave database suites, image scans)                          | todo  |         |       |
| H    | Docs (ADRs 0021/0036–0038, architecture, traceability, report, README, accessibility records)               | todo  |         |       |

## Verified by (task A)

- Local stack (`docker compose up`): every enclave service healthy; `cjis-provision` builds realm `cjis` idempotently (two runs). The enclave gateway answers on `https://localhost:8443` with its own CA, the issuer `https://localhost:8443/auth/realms/cjis`, a strict CSP, and 404 for `/auth/admin` and the master realm; unknown API paths are denied (403).
- `tests/integration/stack.int.test.ts` (28 cases locally): the platform API cannot open any enclave service (`cjis-idp`, `cjis-api`, `cjis-keys`, `cjis-gateway`, `cjis-web`, `cjis-db`); the enclave API cannot open the platform's database, identity provider, queue, keys, objects or API; only `cjis-gateway` publishes a port, on 127.0.0.1.
- Second factor settled by experiment on Keycloak 26.0.7 (ADR-0036 to record): the AMR mapper with a method reference on each authenticator puts `amr: ["pwd","otp"]` (direct grant) or `["pwd","hwk"]` (browser, passkey) in the token, and it survives a refresh; a password-only direct grant is refused. The API will accept `amr` values from `CJIS_SECOND_FACTORS` (production `hwk`; the development stack adds `otp` for its test client).
- Unit: `services/cjis-api/test/config.test.ts` (production mode refused without the authorized environment and the audit date, SCL-12), `realm.test.ts` (lockout 5 in 15 minutes for 10 minutes, 30-minute idle, 15-character passwords with history, no self-registration or email reset, events).
- Sandbox notes (not repository changes): Docker Hub rate limits and a blocked Alpine CDN here, so images were pulled through a registry mirror and built with the proxy CA as the Dockerfiles' `extra_ca` secret; MinIO was built from the same pinned source without the `apk` step; RabbitMQ's cookie in a fresh volume needed its owner fixed. CI builds as before.

## Verified by (task B)

- `packages/cjis-db` migrations 0002–0004: agency keys, people with screening status and dates, permission requests and role grants (the database refuses a decision by the requester), the identity outbox and sign-in cursor; records keyed by `cji_ref`, people involved in law-enforcement roles, weapons, body-camera references, the append-only timeline and idempotency keys (every identifying or free-text value encrypted, `*_enc`); the enclave's own hash-chained audit with its sequence drawn after the chain lock, weekly reviews, retention policies with floors, legal holds and the deletion log.
- Migration drill on a throwaway enclave database (`scripts/cjis-test-db.sh`): all four migrations down and up, no undocumented or stale dictionary column, row security forced on every agency table.
- `packages/cjis-db/test/enclave.db.test.ts` (15 cases): an agency sees only its own people, records, agency and audit rows; no context sees nothing; no writes into another agency; agencies by the system only; opaque references only; no self-decided permission request; the timeline is append-only; records leave only through the system role with their entries; retention floors; the sign-in cursor and dictionary closed to requests; 40 concurrent audit writers verify; no role updates or deletes audit rows (the schema owner changes nothing under forced row security); a tampered row is found.
- Exercise agencies and accounts (`services/cjis-api/src/provision/exercise.ts`): two agencies, twelve accounts with one role each, two deliberately not qualified (training lapsed, fingerprint check pending) and one used only for the lockout drill; identities with the development password and one-time code. Stack suite (28 cases) passes with the second-factor and lockout cases.

## Verified by (task C)

- `services/cjis-api`: token verification (enclave issuer and `cjis-api` audience only; `amr` must hold an accepted second factor, otherwise 401 and an audit row against the account); the subject rebuilt from the enclave database on every request (account, agency, roles, screening; migration 0005 lets a request read only the account its token names before the agency is known, and last-seen writes no longer bump the version); the enclave policy E1–E6 (default deny, CJIS-qualified for everything but one's own account, agency scope, audit immutable, second administrator and nobody administering their own account, nobody reviewing their own disposition; no break-glass); every denial audited; consequential actions need confirmation and a reason; If-Match versions; idempotent creates with the stored response encrypted.
- Routes: records (create on first use per reference, update, people in law-enforcement roles, weapons, body-camera references, removal with reason, narratives and amendments, disposition that closes, supervisor review and reopen, the timeline), accounts (create, screening dates, activation with a one-time password shown once, suspend, reactivate, deactivate), role requests (request, approve, reject, withdraw), audit (filter, verify, CSV export with formula-safe cells, weekly review), retention (floors), legal holds, the deletion log; `/api/v1/notice` is the only public route.
- `cjis-worker` (new container, `cjis_job` and the admin client; the API holds neither): identity outbox with retries (the one-time password leaves the database once the identity exists), sign-in events copied into the audit per agency, the retention sweep honouring legal holds, 90-day inactivity suspension.
- Tests: `policy.test.ts` (13), `token.test.ts` (7), `api.db.test.ts` (24, against the throwaway enclave database: a platform-issuer token refused, no second factor refused and recorded, unknown subject refused, lapsed training and pending check denied with what is missing, the full record journey, 409 with the current record, idempotent replay, removal with reason, confirmation for disposition, E6, another agency sees nothing, no marker string in clear in any enclave table including the audit and idempotency store, reads and writes in the audit by field name, onboarding with a second administrator and the outbox, suspension effective on the next request, audit review and export, retention floors and a legal hold surviving the sweep, sign-in events copied once, inactivity suspension); stable over three runs. Migration drill: 0004 and 0005 down and up.
- Stack smoke through `https://localhost:8443` with real Keycloak tokens: `/me` qualified, record and person created, a lapsed officer denied with `security_training` missing, the chain verifies; the worker copied logins, failures and the lockout drill's lockouts into the audit.

## Verified by (task D)

- Migration 0041: `cg.mission.cji_ref` (opaque, 43 base64url characters, unique, checked by the database), `cji_linked_at`, `cji_linked_by`; the placeholder person role `enclave_reference` and its column retired (a development row becomes "other"); new `bodycam_reference` media refused (NOT VALID check). The drill runs 0040 and 0041 down and up with no undocumented or stale column (the rollback restores the retired dictionary row by hand).
- `packages/authz`: explicit actions `mission.cji.link` (consequential) and `mission.cji.open`, never covered by a wildcard; template `law_enforcement_liaison`. `packages/db/test/dictionary.test.ts`: no platform column is classified `cji`, and the only enclave trace is the mission's three link columns.
- `routes/missions.ts`: `POST /missions/:id/cji-link` (confirmation and reason, one reference per mission, a race answers the winner's, partners refused); the mission detail carries `cjis` (`{ restricted: true }` for console readers; reference, enclave address and link time for holders of `mission.cji.open`, read audited); the list carries the marker; phones (own-record grants) and partners get nothing; body-camera media answers 422 `cji_in_enclave`. Field sync and the dispatch board select explicit columns, so the reference never reaches them.
- Seed: the liaison `liaison@example.org` and an exercise mission (`law_enforcement_support`) linked with the fixed exercise reference; the enclave's provisioning writes the sheriff's encrypted exercise record for the same reference (a test checks both sides name it). Through the enclave gateway the sheriff's deputy reads it decrypted and the city police get 404.
- `services/api/test/cjislink.db.test.ts` (8 cases) and the existing mission, dispatch, field and roster suites pass against the compose database.

## Verified by (task E)

- `apps/web-cjis` (served by `cjis-web` behind `cjis-gateway` only): the system use notification before sign-in (AC-8); sign-in with PKCE against realm `cjis`; workspaces by enclave role; an unqualified account sees what is missing and nothing else; records list; the record page from the console's link (create on first use with the declared mission, classification and summary, people involved in law-enforcement roles, weapons, body-camera references, removal with a reason, narratives and amendments (amendments only once closed), the disposition through the confirmation dialog, supervisor review and reopen, the timeline; a version conflict shows the current record); accounts and screening with the one-time password shown once; approvals by a second administrator; audit review with filters, chain verification, CSV export and the weekly review; retention and legal holds; the 30-minute lock that hides the screen and ends the session (AC-11).
- Found and fixed with the browser journey: (1) the very first sign-in registers the passkey as a setup step, so that session's token proves the password only; the API refuses it (fail closed, audited) and the app now asks for a sign-in with the passkey (`prompt=login`). (2) The authenticators' method references had a max age of 0, so a token issued even a second after a factor was checked (the browser redirect, a refresh) could lose it from `amr`; provisioning now sets the session's maximum lifespan and updates existing configs. (3) The API logs the code of a refused sign-in (never the token).
- `tests/e2e/cjis.spec.ts` (desktop and phone, 4 passes locally): an administrator onboards a fresh account through the API (screening, a role approved by the security officer, activation with the one-time password); the person reads the notification, signs in, changes the password, registers a passkey on a virtual authenticator, signs in with it, opens a console-style link, creates the record, adds a suspect, a weapon, a body-camera reference and a narrative, records the disposition with a reason and sees the record closed; the app locks after the (shortened) idle limit and hides the record; axe finds no violations on the notification, home, record, dialog and lock screens; no horizontal scroll at phone width. A lapsed officer is refused records with `security_training` missing.

## Verified by (task F)

- `apps/web-console/src/screens/missions.tsx`: the mission page's "Law enforcement (CJIS)" panel shows "Restricted: CJIS" to readers, and to holders of `mission.cji.open` the explanation and "Open in the CJIS enclave (new tab)" (`rel="noopener noreferrer"`); holders of `mission.cji.link` on an unlinked mission get "Link to the CJIS enclave" through the confirmation dialog; the missions list has a "Law enforcement" column with the marker. The console never calls the enclave.
- `tests/e2e/console-l5.spec.ts` (desktop and phone, 4 passes locally): an onboarded liaison opens the exercise mission, the link names the enclave origin, the exercise reference, the mission reference and the county; following it opens the enclave's own notification page on its own origin; linking a new mission asks for a reason and then shows the link; an onboarded field coordinator sees "Restricted: CJIS", no link and no link button, and the marker in the list; axe passes on each screen.

## Known issues and deferred items

- Deferred IDs in `layer-5.md` §11; readings flagged for Adam in §12; questions with defaults in force in §14.
- The CJIS Security Policy PDF hosts are blocked by this environment's egress policy, so the values in `layer-5.md` §4 come from the policy's known control text and are marked for confirmation by the agency's CJIS Systems Officer.
