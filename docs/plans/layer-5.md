# Layer 5 plan: CJIS enclave

Written 2026-10-13 after Adam merged layer 4 (Mennelabs/EOC-Application#7) and decided to proceed to the enclave (`docs/decisions.md`). Build order SCL-14 step 5. Status record: [`layer-5-status.md`](layer-5-status.md). Everything from layers 1–4 keeps applying on the platform side: RLS, audit of every write and every restricted read, idempotency, versions, the error envelope, the data dictionary, retention categories, synthetic data only (SCL-12).

Layer 5 is the separate enclave that stores criminal-justice information (CJI) for law-enforcement work on a mission. It is **not** an integration with outside law-enforcement systems: CAD, NCIC and records-management systems stay out unless separately approved (INT-07, decision 2026-10-13), and nothing here replaces 911 or dispatches police, fire or EMS (DSP-13, CON-10).

## 1. Requirement IDs covered

| Area                               | IDs                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The enclave itself                 | SEC-12 (own network boundary, database, keys, identity with its own MFA, audit and personnel screening; CJIS Security Policy v6.x), SCL-12, CLAUDE.md rule 2, ADR-0021                                    |
| Law-enforcement data on a mission  | PPL-01 (law-enforcement roles and details of people involved), BRD:FR-07.02 (one authoritative people representation), BRD:FR-07.04 (bodycam references), BRD:FR-04.01 (weapons detail), BRD:D02, BRD:D07 |
| Narratives and outcomes in the CJI | BRD:FR-07.01 (attributable amendments), BRD:FR-07.03 (time-stamped events apart from summaries), BRD:FR-07.05 (law-enforcement disposition, case number, reviewer), BRD:FR-07.06                          |
| Guardrails                         | ADM-05 ("criminal-justice data only for CJIS-qualified users"; audit records immutable; second administrator for grants), BRD:FR-00.01, BRD:FR-08.04, SEC-06                                              |
| Retention                          | SEC-13 (CJIS data follows CJIS and state records rules; legal holds override deletion)                                                                                                                    |
| Cross-cutting, enclave side        | SEC-10 (encryption at rest per agency key and in transit), SEC-11 (every enclave column classified), SEC-18 (tamper-evident audit), SEC-07 (phishing-resistant MFA), FR-00.05/06 (versions, idempotency)  |
| Gates                              | GATE-01, GATE-02, GATE-03 (the enclave screens), GATE-04 (no bypass of the boundary), GATE-05 (versions and idempotency in the enclave)                                                                   |

Not in this layer, with reasons, in §11.

## 2. How the two halves meet (refines ADR-0021)

1. **The platform holds a pointer, never CJI.** A mission gains `cji_ref`, a random 256-bit opaque reference, set when a platform user with the new explicit action `mission.cji.link` links the mission to the enclave (consequential: confirmation and a reason, audited). Nothing else about law enforcement is stored on the platform.
2. **The enclave serves its own screens on its own address.** ADR-0021 and `architecture.md` §2.2 had the console fetch CJI from `cjis-gateway`. That would run platform-served code over CJI. Instead the enclave serves its own web app (`apps/web-cjis`) from `cjis-gateway` on its own origin (locally `https://localhost:8443`, in the cloud its own domain in its own account). The console only links to it. CJI then never passes through the platform's API, logs, queue, AI providers **or browser code**. ADR-0021 is updated and ADR-0038 records the choice.
3. **Who sees what on the platform.** A user who can read the mission and holds `mission.cji.open` sees "Law-enforcement details are held in the CJIS enclave" with an "Open in the CJIS enclave" link carrying the reference. Other console users who can read the mission see "Restricted: CJIS" and nothing else. Phones (field sync), partner workspaces and public channels never receive the marker.
4. **The enclave owns the content.** The enclave keys its record by the same `cji_ref` and the owning agency. The link's mission reference and county are stored in the enclave as declared context, so an officer sees which mission a record belongs to. The enclave never calls the platform and the platform never calls the enclave.
5. **The platform refuses CJI-shaped input.** Mission media of kind `bodycam_reference` is refused with a pointer to the enclave. The placeholder person role `enclave_reference` and its column are retired, because law-enforcement people are recorded once, in the enclave (BRD:FR-07.02 "one authoritative representation"). Law-enforcement dispositions (arrest made, citation, report filed) never existed on the platform and stay out.

## 3. Containers (`compose.cjis.yaml`, network `cg_cjis`, internal)

| Service            | What                                                                                                                                                                                                                                       | New |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| `cjis-db`          | Own PostGIS instance and volume; databases `cjis` (records) and `cjis_idp` (the enclave's Keycloak); roles `cjis_migrator` (schema owner), `cjis_app` (no DDL, no audit update or delete), `cjis_idp`                                      | ext |
| `cjis-keys(-init)` | Own OpenBao; per-agency transit keys for field encryption; the API's token in the enclave's own init volume                                                                                                                                | ext |
| `cjis-migrate`     | One-shot: `packages/cjis-db` migrations                                                                                                                                                                                                    | yes |
| `cjis-idp`         | Own Keycloak (same pinned release as the platform) at `/auth` behind `cjis-gateway`; realm `cjis` only                                                                                                                                     | yes |
| `cjis-provision`   | One-shot: realm `cjis` (flows, password and lockout policy, session timeouts, clients), the API's least-privilege admin client, and on synthetic stacks the exercise agency and its accounts                                               | yes |
| `cjis-api`         | Fastify API: records, people, weapons, bodycam references, dispositions, narratives, accounts and screening, role requests, audit review, retention and legal holds; scheduled jobs (identity outbox, retention sweep, inactivity disable) | ext |
| `cjis-web`         | Static build of `apps/web-cjis` (Caddy)                                                                                                                                                                                                    | yes |
| `cjis-gateway`     | The enclave's only published port (`127.0.0.1:${CJIS_HTTPS_PORT:-8443}`): TLS with its own local CA, strict CSP, routes `/api` → `cjis-api`, `/auth` → `cjis-idp`, `/` → `cjis-web`. In the cloud: mutual TLS and its own ingress          | yes |

No enclave container joins `cg_platform`, and no platform container joins `cg_cjis`. A production guard: `cjis-api` refuses to start with `DATA_CLASSIFICATION_MODE=production` unless the deployment declares an authorized environment and a passed state CJIS audit date (SCL-12). Locally the mode is always `synthetic`.

## 4. Enclave identity and personnel screening (SEC-12, CJIS Security Policy)

- **Separate realm `cjis` in the enclave's own Keycloak.** No federation with the platform realms, no shared accounts, no SSO from the console.
- **MFA on every sign-in:** password then passkey (WebAuthn, user verification required), as on the platform (SEC-07). The API also refuses any token whose authentication did not include the second factor, so a mis-set flow fails closed. How the token proves it (`acr` or `amr`) is settled by experiment in task A and recorded in ADR-0036.
- **Configured CJIS values** (recorded in ADR-0036; the agency's CJIS Systems Officer confirms them against the v6.x text at the state audit, because the policy PDF hosts are blocked from this build environment):

| Control                              | Value configured                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Unsuccessful sign-ins (AC-7)         | 5 consecutive failures within 15 minutes lock the account for 10 minutes or until an administrator releases it          |
| Device and session lock (AC-11/12)   | The enclave app locks after 30 minutes without activity and hides the screen content; the identity session ends with it |
| System use notification (AC-8)       | Shown before sign-in and acknowledged; the text is tenant configuration                                                 |
| Inactive accounts (AC-2)             | Suspended after 90 days without a sign-in, by a scheduled job, audited                                                  |
| Security awareness training (AT-2)   | Required before access and renewed every 12 months; an expired date denies access                                       |
| Personnel screening (PS-3)           | A fingerprint-based record check, adjudicated, is required **before** access (stricter than "within 30 days")           |
| Passwords (IA-5)                     | At least 15 characters, not the username or email, last 10 not reused; MFA always required on top                       |
| Audit retention and review (AU-6/11) | Kept at least 7 years (the platform's floor, above the CJIS one-year minimum); weekly review recorded in the enclave    |

- **"CJIS-qualified"** is decided on every request from the enclave database, never from token claims alone: an active enclave account, an adjudicated fingerprint check, current training, an active agency, an approved role, and a token from the enclave realm with the second factor. Anything missing denies the request and audits the denial.
- **Screening records hold status and dates only**, never the fingerprint results themselves (as background checks in FL:FR-20).
- **Onboarding without email or texts:** the enclave has no mail server. An agency administrator creates the account; a second administrator approves its first role; the identity is created with a one-time temporary password shown once to the administrator and handed over in person; the person sets a password and registers a passkey at first sign-in.

## 5. Enclave data model (`packages/cjis-db`, schema `cjis`, every column in the enclave dictionary)

| Table                                            | Purpose and key columns                                                                                                                                                                                                                                                                                                                                                                                     | IDs                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `agency`                                         | A criminal-justice agency: name, synthetic agency identifier (exercise only), the platform county it serves, status, the system use notification text                                                                                                                                                                                                                                                       | SEC-12                     |
| `agency_key`                                     | Wrapped per-agency data keys (envelope encryption, as the platform's tenant keys)                                                                                                                                                                                                                                                                                                                           | SEC-10                     |
| `person`                                         | Enclave accounts: agency, identity subject, name, email, status (invited, active, suspended, deactivated), fingerprint check (status, adjudicated by and when), training (completed, expires), last sign-in, created and approved by                                                                                                                                                                        | SEC-12, ADM-05             |
| `role_grant`, `permission_request`               | Roles held (officer, supervisor, records clerk, agency administrator, security officer, auditor); every grant or revoke is a request another administrator approves; nobody approves their own                                                                                                                                                                                                              | ADM-05, BRD:FR-08.04       |
| `record`                                         | One per linked mission: `cji_ref`, agency, declared platform county and mission reference, origin (911, non-emergency, officer-initiated, walk-in, text, radio), law-enforcement classification and offense codes, case number (encrypted), disposition (arrest made, citation issued, report filed, no action taken, transported, referred, completed) with explanation, reviewer and time, state, version | BRD:D02, BRD:FR-07.05      |
| `record_person`                                  | People involved in law-enforcement roles (suspect, arrestee, victim, witness, complainant, subject, reporting party, other): name, date of birth, necessary demographics, contact, address, identifiers and notes, all encrypted; removal keeps the row and reason                                                                                                                                          | PPL-01, BRD:D07, FR-07.02  |
| `record_weapon`                                  | Kind, description, serial number (encrypted), disposition (observed, seized, returned, unknown), linked person                                                                                                                                                                                                                                                                                              | SEC-12, BRD:FR-04.01       |
| `record_bodycam`                                 | References only (no video in the enclave): camera label, officer, recorded from and to, evidence-system reference (encrypted), notes                                                                                                                                                                                                                                                                        | BRD:FR-07.04               |
| `record_event`                                   | Append-only timeline: created, updated, narrative by role (officer, supervisor, records), amendments pointing at what they amend, person/weapon/bodycam added or removed, disposition                                                                                                                                                                                                                       | BRD:FR-07.01, FR-07.03     |
| `audit_event`                                    | Append-only, hash-chained per agency (same design as the platform's ADR-0012, its own chain); every read, write, denial, sign-in seen, export and review; `audit_review` records the weekly review                                                                                                                                                                                                          | SEC-18, BRD:FR-08.04, AU-6 |
| `retention_policy`, `legal_hold`, `deletion_log` | Per agency and category (records after closure, audit); holds by record or agency; each deletion batch logged and audited                                                                                                                                                                                                                                                                                   | SEC-13                     |
| `idempotency_key`, `identity_outbox`             | Replays of creates (FR-00.06); identity changes for Keycloak applied by the API's job loop with retries                                                                                                                                                                                                                                                                                                     | FR-00.06                   |
| `data_dictionary`                                | Every enclave column with its classification (`cji`, `restricted`, `internal`); the migration fails on an undocumented column (SEC-11)                                                                                                                                                                                                                                                                      | SEC-11                     |

Row-level security is forced on every table that carries `agency_id`: an agency sees only its own records. Cross-agency sharing inside the enclave is not built (§14 question 4).

**Platform migration 0041:** `cg.mission.cji_ref` (unique, opaque, classified `restricted`), `cji_linked_at`, `cji_linked_by`; `cg.mission_person.enclave_reference` and the `enclave_reference` role retired; a check refusing new `bodycam_reference` media (existing exercise rows are left in place, not valid for new inserts). A unit test fails if any platform dictionary column is classified `cji`.

## 6. APIs

**Platform (`/api/v1`, through the policy engine):**

- `POST /missions/:id/cji-link` (`mission.cji.link`, consequential): creates the reference once; a second call answers the same reference.
- `GET /missions/:id` adds `cjis`: absent when unlinked; `{ restricted: true }` for readers; `{ restricted: true, ref, url }` for holders of `mission.cji.open` (the read is audited). `GET /missions` adds `cjisRestricted`.
- Field sync, partner views and the stream carry nothing about the enclave.

**Enclave (`https://localhost:8443/api/v1`, enclave token only):**

- `GET /me` (account, agency, roles, qualification and what is missing), `GET /notice` (system use notification, public).
- Records: `GET /records` (own agency), `GET /records/:ref`, `PUT /records/:ref` (create on first use with the declared mission context; idempotent), `PATCH /records/:ref` (If-Match), people, weapons and bodycam references (add, update, remove with a reason), `POST /records/:ref/narratives` (append; amendments name what they amend), `POST /records/:ref/disposition` (consequential), timeline.
- Accounts: list, create, record screening and training, suspend, reactivate, deactivate; role requests, approve, reject; the one-time temporary password returned once on identity creation.
- Audit: search with filters, `POST /audit/verify`, CSV export (audited), `POST /audit/reviews` (weekly review with a note).
- Retention: policies per category, legal holds placed and released, deletion log.
- Every read of a record, every write, every denial and every export writes an enclave audit row in the same transaction; denials in their own transaction.

## 7. Screens (`apps/web-cjis`, English, staff only; WCAG 2.2 AA)

1. **System use notification** with "I understand", then sign-in (OIDC with PKCE against realm `cjis`), then passkey.
2. **Records**: the agency's records with reference, mission, classification, disposition and last change.
3. **Record** (opened from the console link `/records/<ref>?mission=M-00012&county=<id>`): "Create the enclave record for mission M-00012" when new; classification and origin; people involved with law-enforcement roles; weapons; bodycam references; disposition through the confirmation dialog; narratives with amendments; the timeline. Version conflicts show the current record.
4. **Accounts and screening** (agency administrator): create, screening and training dates, suspend, role requests, the one-time password shown once.
5. **Approvals** (second administrator): pending role requests, never one's own.
6. **Audit review** (security officer, auditor): filters, chain verification result, export, record the weekly review.
7. **Retention and legal holds** (security officer).
8. **Locked**: after 30 minutes without activity the screen hides its content and asks to sign in again.

**Console:** the mission detail gains the CJIS panel (§2.3) and "Link to the CJIS enclave" for holders of `mission.cji.link`; the missions list shows a "CJIS" text marker.

## 8. Platform roles

- New explicit actions `mission.cji.link` and `mission.cji.open` (never covered by `*` or `mission.*`, as `position.read` in layer 4).
- New template `law_enforcement_liaison` (mission and event reads, both CJIS actions). The seed adds an exercise liaison account in the county and links one exercise mission.

## 9. Tests

- **Unit:** the enclave policy (default deny, qualification, roles, second administrator, no self-approval, agency scope, audit immutability), token verification against a local key set (platform issuer refused, no second factor refused, wrong audience, expired), the retention calculation, schemas, the platform dictionary guard, the new platform actions and template.
- **Enclave database suites** (`services/cjis-api/test/*.db.test.ts`) against a throwaway `cjis-db` started from the same init script on `127.0.0.1:5433` (CI step and `scripts/cjis-test-db.sh`); the compose enclave publishes no database port: RLS per agency, audit append-only for `cjis_app`, chain verification and tamper detection, CJI columns stored as ciphertext, every route with versions (409) and idempotent replays, unqualified people denied and audited (training expired, check pending, suspended, other agency), second-administrator rule, retention with a legal hold, inactivity suspension, identity outbox retries.
- **Platform database suite:** linking, the marker by role, the field sync without it, bodycam references refused, the retired role refused.
- **Stack suite (`tests/integration/layer5.int.test.ts`):** the network boundary both ways (platform containers cannot reach any enclave service; enclave containers cannot reach the platform database, queue, keys, objects or identity provider); only `cjis-gateway` is published; a platform token is refused by the enclave; a token without the second factor is refused; the liaison links a mission and the enclave records people, a weapon, a bodycam reference, a disposition and narratives against it; the synthetic CJI marker strings appear nowhere in the platform database and only as ciphertext in the enclave database; the enclave audit chain verifies and holds the reads, writes and denials.
- **Browser + axe:** the enclave app (notice, sign-in with a passkey on a virtual authenticator, record with people, weapon, bodycam reference and disposition, audit review, the lock) on desktop and phone viewports; the console's CJIS panel for a liaison and for a reader without the action.
- **CI:** the enclave database suites, the new images in the container scans, the migration drill for both databases.

## 10. Build order (one task per commit, status in `layer-5-status.md`)

P. This plan.
A. Enclave containers and identity: `cjis-db` roles and the identity database, `cjis-idp`, `cjis-provision` (realm, flows, policies, clients, admin client), `cjis-web` placeholder and `cjis-gateway` on its own port, secrets in `init-env`, config schemas, the production guard; the second-factor claim settled by experiment; stack readiness and isolation cases.
B. Enclave database `packages/cjis-db`: migrations, dictionary, RLS, audit chain, retention, synthetic agency and accounts for `cjis-provision`; the migration drill.
C. Enclave API: authentication, qualification, policy, audit, encryption, idempotency and versions; records, people, weapons, bodycam references, dispositions, narratives; accounts, screening, role requests; audit review and export; retention and holds; scheduled jobs. Unit and database suites.
D. Platform side: migration 0041, actions and template, mission routes, nothing in field sync or partner views, the seed liaison and linked mission, the dictionary guard; platform database cases.
E. Enclave web app `apps/web-cjis`.
F. Console CJIS panel and link action.
G. Tests and CI: layer-5 stack suite, browser journeys with axe, enclave database suites and image scans in CI.
H. Docs: ADR-0021 update, ADR-0036 (enclave identity and screening), ADR-0037 (enclave data, keys, audit, retention), ADR-0038 (enclave app on its own origin), `architecture.md`, traceability (`trace-layer5.json`), layer-5 report, README, accessibility records.

Then the pull request into `main`, merged when CI is green (Adam, 2026-10-13).

## 11. Deferred, with reasons

| What                                                                                                 | Why                                                                                                                    | When             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| CAD, NCIC, records-management integrations (INT-07)                                                  | separately approved contracts only (decision 2026-10-13)                                                               | ask Adam         |
| Danger flags handed to 911 through the enclave (docs/02 "later")                                     | dispatch-like; CON-10 keeps danger flags awareness-only                                                                | ask Adam         |
| Real CJI in the enclave                                                                              | only after the move to an authorized government cloud and a passed state CJIS audit (SCL-12)                           | Gov              |
| FIPS 140-validated cryptography, mutual TLS, separate cloud account                                  | provided by the government cloud's KMS, ingress and account boundary; locally OpenBao and plain HTTP inside `cg_cjis`  | Gov              |
| Audit anchors to object-locked storage for the enclave chain                                         | the enclave has no object store locally; the verifier and the chain run now, anchors move with the cloud's object lock | Gov              |
| Cross-agency sharing of a record inside the enclave                                                  | needs an agreement model between criminal-justice agencies                                                             | §14 question 4   |
| Spanish for the enclave screens                                                                      | staff-only screens like the console; EQ-06 covers resident and public strings                                          | with the console |
| CJIS Security Policy evidence beyond the build (SSP, CSA audit, training content, incident response) | process and agency work, not code                                                                                      | Process          |

## 12. Readings taken in favour of safety and privacy (flagged for Adam)

1. **The enclave serves its own screens on its own address**; the console only links (§2.2). Stricter than ADR-0021's original text.
2. **A weapons hazard stays on the platform as an awareness flag** (responder safety, BRD:FR-04.01, CON-10) with no detail; weapon details (kind, description, serial number, what happened to it) are CJI and live only in the enclave.
3. **The "Restricted: CJIS" marker** is shown only in the console to people who can read the mission; phones, partners and the public never see it.
4. **Fingerprint checks are required before access**, not within 30 days of assignment; training expiry denies access the day it lapses.
5. **Screening records hold status and dates only.**
6. **No email or texts from the enclave**; the temporary password is handed over in person.
7. **Retention default for CJIS records: 7 years after closure** until the agency enters its state records schedule; legal holds override; enclave audit kept at least 7 years.
8. **One agency owns each record**; another agency sees nothing until sharing is approved.
9. **No break-glass in the enclave.** Emergency access to CJI goes through the agency's own procedures.

## 13. Gates claimed at the end of this layer

GATE-01 (scope and roles here), GATE-02 (the cases in §9), GATE-03 for the enclave screens and the console panel on automated evidence (screen-reader passes by a person), GATE-04 (the boundary and the qualification checks), GATE-05 (versions and idempotency in the enclave).

## 14. Questions for Adam (recommended defaults in force behind configuration until answered)

1. **Enclave screens on their own address** instead of inside the console (§2.2). Default: own address.
2. **CJIS records retention**: default 7 years after closure until the agency's state records schedule is entered.
3. **Who holds the liaison role in a county**: default nobody but the exercise liaison; the county administrator grants it like any role.
4. **Cross-agency sharing inside the enclave** (a sheriff's office and a city police department on one mission): default one owning agency, no sharing.
5. **The CJIS values in §4** are to be confirmed by the agency's CJIS Systems Officer against the policy text.
