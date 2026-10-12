# Layer 3 plan: needs board, partner sharing with consent, public "Find help"

Written 2026-10-12 after Adam approved layer 2 ("Approved, next layer"). Build order SCL-14 step 3. Status record: [`layer-3-status.md`](layer-3-status.md). Everything from layers 1 and 2 keeps applying: RLS, audit of every write and every restricted read, idempotency, versions, the error envelope, the data dictionary, retention categories, the fake AI provider, the simulator for texts and calls, synthetic data only (SCL-12).

## 1. Requirement IDs covered

| Area                                  | IDs                                                                                                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs board and claims                | NED-02 (needs without a damage report), NED-07 (claim and release, CSV and API export), NED-08 (someone to talk with, faith-neutral), CON-08, CON-15, CON-04 (key counts); AC-17B                                                  |
| Partner sharing with consent          | NED-03 (enforced on sharing), NED-04 (minimum fields per service), NED-05 (withdrawal by web and text, partners told, access gone within the hour), AC-17C, FL-03 (sections a partner may see), ADM-02 (partner active in a day)   |
| Referrals, contacts, resident updates | BRD:FR-17.01–17.05 and AC-17A/B/C, CNT-01, FL-10 (warm referrals), FL-11 (plain-language text updates with replies), RULE-12                                                                                                       |
| Sites and public information          | CON-09, NED-06, PUB-01–PUB-11, PUB-13 (page), PUB-15, PUB-16, PUB-17, PUB-18, A11Y-01, BRD:FR-16.01–16.05, AC-16A/B/C, BRD:FR-11.06 (approved public resources), SCL-13 (first map: the optional map on the public page and sites) |
| Cross-cutting                         | SEC-05/06 (partner tenants see only shared records), SEC-18 (every partner read of a resident's record audited), SCL-06 (the public page works without the geocoder and without the map), EQ-06 (English and Spanish everywhere)   |

Not in this layer, with reasons, in §11.

## 2. Data model (migrations 0021–0026, every column in `dictionary.ts`)

| Table              | Purpose and key columns                                                                                                                                                                                                                                                                                                                                                                                                                          | IDs                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `need` (extended)  | `claimed_by_tenant_id`, `claimed_by_account_id`, `claimed_at`, `assigned_by_account_id`, `released_at`, `done_at`, `done_note`, `source` (report/standalone/staff), `location_id` (standalone needs carry their own place), `contact_party_id`; status gains `in_progress`. One row per category per household.                                                                                                                                  | NED-02, NED-07, CON-08           |
| `need_event`       | The board's history: `need_id`, `kind` (claimed/assigned/released/done/reopened/overlap_warned/exported), `actor_account_id`, `actor_tenant_id`, `note`, `at`. Immutable.                                                                                                                                                                                                                                                                        | CON-08, AC-17B                   |
| `board_visibility` | Per event (or tenant default): who sees whose claims: `scope` (role/agency/person), `subject_id`, `sees` (own/consented/all), set by an administrator with a reason; defaults follow consent.                                                                                                                                                                                                                                                    | CON-15                           |
| `share_grant`      | Materialised sharing: `report_id`/`need_id`, `party_id`, `to_tenant_id` (partner organization), `org_type`, `sections[]` (the minimum-field projection for that service), `consent_id`, `agreement_id`, `granted_at`, `revoked_at`, `revoke_reason`, `recall_notice_message_id`. Derived by the worker from consent + the signed data-sharing agreement; the partner API reads only through it.                                                  | NED-04, NED-05, AC-17C, FL-03    |
| `referral`         | `from_tenant_id`, `to_tenant_id` (or `to_org_type` when no partner tenant exists yet), `report_id`, `need_id`, `party_id`, `purpose`, `share_grant_id`, `status` (open/accepted/declined/done), `opened_by`, `accepted_by`, `closed_at`, `outcome`, `attempts` (message ids).                                                                                                                                                                    | FL-10, BRD:FR-17.03/17.04        |
| `partner_contact`  | Interagency contacts (F17): `org_tenant_id` or free-text agency, `name_enc`, `role`, `methods_enc` (phone, email, radio), `type` (operations/24h/backup/media), `active`, `verified_at`, `verify_by` (season check), `backup_of`, `owner_account_id`. Restricted; administration limited to roles with the category.                                                                                                                             | BRD:FR-17.01/17.02, CNT-01       |
| `site`             | Shelters, feeding stops, PODs, MARCs, cooling and warming centers, reporting tables: `kind`, `name`, `location_id`, `status` (planned/open/limited/full/closed), `capacity`, `occupancy`, `hours jsonb`, `services[]`, `pets`, `accessibility jsonb`, `medical_power`, `languages[]`, `transit`, `directions`, `confidential` (never published), `lead_contact_id`, `confirm_every_hours`, `last_confirmed_at`, `last_confirmed_by`, `event_id`. | CON-09, PUB-02, PUB-03, PUB-05   |
| `resource`         | Published information beyond sites: `slug`, `type` (hotline/program/deadline/guidance/link/document), `category`, `ordering`, `owner_account_id`, `status` (draft/published/expired/removed), `review_at`, `expires_at`, `reference_url`, `link_status` (ok/broken/unchecked, checked_at), `targeting jsonb` (event/geography/need/language; never availability or eligibility).                                                                 | BRD:FR-16.01/16.03/16.05, PUB-18 |
| `resource_text`    | Per locale: `title`, `summary`, `body_html` (sanitised, accessible), `human_reviewed_by`, `reviewed_at`. Essential guidance always has HTML, not only a PDF.                                                                                                                                                                                                                                                                                     | BRD:FR-16.04, AC-16C, PUB-06     |
| `publication`      | The approval log: `subject_kind` (site/resource/alert_draft/poster), `subject_id`, `subject_version`, `snapshot jsonb` (exactly what went out), `approved_by`, `approved_at`, `channels[]` (web/sms/voice/feed/widget/print), `unpublished_at`. Nothing is public without a row here.                                                                                                                                                            | PUB-06, AC-16A                   |
| `zip_centroid`     | Per tenant, synthetic for WESTWIND: `postal`, `geom`, `name`. "Nearest" works by ZIP without the geocoder (SCL-06); the geocoder profile adds addresses and landmarks.                                                                                                                                                                                                                                                                           | PUB-07, PUB-08, PUB-09           |

Existing `data_sharing_agreement` (layer 1) is the legal basis per partner tenant; `consent` (layer 2) is the resident's choice per organization type. A grant exists only when both exist. Retention: grants and referrals follow the report (7 years default); publication snapshots 7 years; site confirmations 1 year.

## 3. APIs

**Public (no staff session, rate-limited, cached ≤ 60 s so a change reaches every channel within 2 minutes)**

| Route                                                        | Behaviour                                                                                                                                                                            | IDs                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `GET /api/public/help/:tenant?lang=&near=<zip                | lat,lon                                                                                                                                                                              | text>&kind=`                   | Published, non-confidential, not-stale sites with every PUB-02 field and "last confirmed", nearest first when a place is given; published resources; the next nearest open site of the same kind for every full or closed one; accessibility statement and support contact. | PUB-01–05, PUB-07, NED-06, A11Y-01 |
| `GET /api/public/help/:tenant/resources/:slug?lang=`         | One resource as accessible HTML; expired or removed answers 410 with the date, never silently as current.                                                                            | BRD:FR-16.02/16.04, AC-16A/B/C |
| `GET /api/public/help/:tenant/sites.geojson`, `…/hsds.json`  | Open data feeds (GeoJSON; Open Referral HSDS organizations/services/locations) without confidential sites; documented in the API reference.                                          | PUB-10, PUB-17                 |
| `GET /api/public/help/:tenant/widget.js`                     | Copy-and-paste widget: renders the open sites list into a host page element; same data, same cache.                                                                                  | PUB-16                         |
| `GET /api/public/help/:tenant/media?lang=`                   | The media sheet as a page with "last updated" times (PDF with the FEMA tooling in layer 6).                                                                                          | PUB-13                         |
| `POST /api/public/needs/:tenant` (`Idempotency-Key`)         | A need without a damage report: categories, place (any form), contact and preferred channel, consent per organization type; same queue path as submissions, reference code returned. | NED-02, NED-03                 |
| `PATCH /api/public/intake/:tenant/me/consent` (exists)       | Withdrawal on the web; now also revokes grants and notifies partners.                                                                                                                | NED-05                         |
| Text: `SHELTER`/`REFUGIO` + ZIP or address; `NOSHARE <code>` | Three nearest open sites with hours, pets and accessibility; consent withdrawal by text (docs/06 keyword addition, flagged for Adam).                                                | PUB-08, NED-05                 |
| Voice: "press 2 for the nearest open sites"                  | Reads the nearest open sites in the caller's language from the caller's ZIP; 0 transfers.                                                                                            | PUB-09                         |

**Staff and partner (layer-1 authorization, new actions in the catalog)**

| Route                                                                                   | Actions                                                                                                                                                                 | IDs                           |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `GET /api/v1/needs` (board; filters; visibility applied), `GET /api/v1/needs.csv`       | `need.read`, `need.export` (export audited)                                                                                                                             | CON-08, CON-15, NED-07        |
| `POST /api/v1/needs/:id/claim`, `…/assign`, `…/release`, `…/done`, `…/reopen`           | `need.claim`, `need.assign` (county roles), `need.release`, `need.done`; overlap warnings returned                                                                      | CON-08, NED-07, AC-17B        |
| `GET/PUT /api/v1/board-visibility`                                                      | `board.configure` (consequential, administrator)                                                                                                                        | CON-15                        |
| `GET /api/v1/shared/reports`, `GET /api/v1/shared/reports/:id` (partner view)           | `shared.read`: only through `share_grant`, only the sections granted, every read audited                                                                                | NED-04, AC-17C, FL-03, SEC-18 |
| `POST /api/v1/referrals`, `POST …/:id/accept`, `…/decline`, `…/done`                    | `referral.create` (needs an active grant or consent), `referral.respond`                                                                                                | FL-10, BRD:FR-17.03           |
| `POST /api/v1/reports/:id/messages` (resident update by text or email)                  | `message.send` (templates from docs/06 plus staff text through the output filter; opt-in only)                                                                          | FL-11, BRD:FR-17.04/17.05     |
| `GET/POST/PATCH /api/v1/sites`, `POST …/:id/confirm`, `…/publish`, `…/close`            | `site.read/edit`, `site.publish` (consequential: a named approver), `site.confirm`                                                                                      | CON-09, PUB-02–06             |
| `GET/POST/PATCH /api/v1/resources`, `POST …/:id/publish`, `…/unpublish`, `…/check-link` | `resource.read/edit`, `resource.publish` (consequential)                                                                                                                | BRD:FR-16.01–16.05, PUB-18    |
| `GET /api/v1/publications`                                                              | `publication.read`                                                                                                                                                      | PUB-06                        |
| `GET/POST/PATCH /api/v1/contacts`, `POST …/:id/verify`                                  | `contact.read` (restricted category), `contact.edit`                                                                                                                    | BRD:FR-17.01/17.02, CNT-01    |
| `GET /api/v1/dashboard/counts`                                                          | `dashboard.read`                                                                                                                                                        | CON-04                        |
| `POST /api/v1/partners/invite`, `POST /api/v1/agreements/:id/sign`                      | `partner.invite`, `agreement.sign` (consequential, second administrator for the county side)                                                                            | ADM-02                        |
| `POST /api/v1/alerts/draft`                                                             | `publication.draft`: WEA-sized (90 and 360 characters) and mass-notification text from a site change, deterministic templates; the county sends it through its own tool | PUB-11                        |

## 4. Screens

**Public "Find help" (`apps/web-help`: a small separate page, under 300 KB on first load, English and Spanish, list first, map optional and loaded only when asked; printable with `@media print`)**

1. Open sites nearest to a ZIP, address or landmark (geocoder when the profile is on; ZIP centroids always), each with status, hours, services, pets, accessibility, power for medical devices, languages, transit and "confirmed N minutes ago"; full or closed sites show the next nearest open one (PUB-02/04/07).
2. Published resources by category with their own pages (PUB-18, F16).
3. Accessibility statement and support contact (A11Y-01); "This page never decides eligibility" (RULE-12).
4. Print view: large type, phone number, short address and QR, never the QR alone (PUB-15).

**Console (`apps/web-console`)**

5. Needs board: open, claimed, in progress, done; filters by category, area, partner; claim, assign, release, done with a note; overlap warnings when another claim exists for the same household or address; visibility as configured (CON-08, CON-15, NED-07); CSV export with an audit row.
6. Partner workspace (partner organization tenants): my claims, the consented records with only the sections granted, referrals in and out, "send an update" to the resident with the approved templates (NED-04, FL-10, FL-11, AC-17C).
7. Sites: list and map (optional), open and close, capacity and occupancy, confirm, publish with the approval dialog, confidential flag, next-nearest preview, poster and flyer print view (CON-09, PUB-03–06, PUB-15).
8. Resources: editor with an accessibility check of the HTML (headings, links with text, no PDF-only guidance), translations marked human-reviewed, review and expiry dates, link check, publish (F16, PUB-18).
9. Publication log (PUB-06). Alert and mass-notification drafts from a site change (PUB-11).
10. Contacts registry with verification dates and seasonal re-verification reminders (F17, CNT-01).
11. Key counts on the console home with as-of time (CON-04); the situational-awareness list equivalents (sites, needs by area) now, map layers with the field app (CON-03 in layer 4).
12. Partner onboarding: invite an organization, send the data-sharing agreement, both sides sign, the partner's administrator sets up users (ADM-02; the second-administrator rule applies on the county side).

## 5. Channels

- **Text (PUB-08, NED-05):** `SHELTER 63001` / `REFUGIO 63001` answers with the three nearest open sites in that language (name, address, hours, pets, accessibility, the help page link); `NOSHARE KXMR-4827` withdraws sharing consent for that report and confirms. Keywords added to `docs/06` and flagged for Adam's carrier submission.
- **Voice (PUB-09):** a new option in the greeting reads the nearest open sites from the caller's ZIP (keypad) in the caller's language; 0 transfers.
- **Resident updates (FL-11):** partners and county staff send templated updates ("A cleanup crew is scheduled for Tuesday morning") by text or email to residents who opted in; replies land on the report as messages and show in the board; message states as in layer 2 (FR-17.05).
- **Feeds (PUB-10, PUB-17):** HSDS and GeoJSON read the same published records; 211 centers poll them; a documented API page lists the fields.

## 6. Sharing model (the heart of the layer)

1. The resident consents per organization type (layer 2). The county has a signed data-sharing agreement with a partner tenant naming the organization type and data categories (layer 1).
2. The worker derives `share_grant` rows when a report or need is filed and whenever consent or an agreement changes: one grant per partner tenant that matches, carrying the minimum-field section list for that service (NED-04 table in `packages/authz/src/sharing.ts`: cleanup gets address, need, contact preference and name; feeding gets area and household size band; counseling gets a contact method only; legal aid gets name and contact; shelter gets access needs only when the resident asked for shelter).
3. Partner routes read only through grants; the policy engine's `shared.read` action checks the grant's sections; every read is audited with the grant id (SEC-18).
4. Withdrawal (web or text) revokes every grant for that organization type at once, queues a recall notice to each partner that had one, and the board hides the record from them. The hour in NED-05 is the ceiling; the design does it in seconds.
5. Exports already taken cannot be recalled; the recall notice names what was shared and when, and the partner's agreement obliges deletion (recorded in the agreement terms).

## 7. Maps (first use, SCL-13)

MapLibre GL with the self-hosted tiles (`COMPOSE_PROFILES=maps`) appears in two places: the optional map on the public page and the sites screen. Without the profile the pages show the list only and say so; the geocoder (opt-in) adds address and landmark search; ZIP centroids ship with the seed so "nearest" always works. USNG on site records. ADR-0029 records the choice and the offline packages for layer 4.

## 8. Needs without a report (NED-02)

A short public flow (categories, place in any form, contact and preferred channel, consent) through the same queue; reference code; the board shows it as a standalone need. A household that later reports damage is linked by the worker through the reference code or a matching contact, never merged silently.

## 9. Tests

- Unit: minimum-field projections per organization type, grant derivation (consent × agreement), overlap detection, next-nearest, stale-site hiding, HSDS and GeoJSON mapping, WEA sizing, resource HTML accessibility check, ZIP nearest.
- Database-backed: board claims, assignment, release, done and history; visibility configuration; grants created and revoked with recall notices; partner reads limited to sections and audited; referrals; sites publish/confirm/hide/close with next nearest; resources draft/published/expired/removed; publication log; contacts restricted.
- Stack suite: AC-16A/B/C; AC-17A (email shows no delivery without evidence), AC-17B (retry without a duplicate), AC-17C (partner sees only what was authorised); NED-04/05 end to end with a partner tenant and consent withdrawal by web and by text; CON-08 overlap warning; PUB-01 change visible on web, text and feed within 2 minutes; PUB-03 hidden after the confirmation window; PUB-04 next nearest; PUB-05 confidential site absent from every public output; PUB-08 `SHELTER 63001`.
- Browser + axe: the public page in English and Spanish, keyboard only, print view, 320 px; console needs board and sites journeys through the confirmation dialog; partner workspace.
- Size and load: the public page's first load under 300 KB (CI budget), k6 smoke on the help endpoint.
- Manual: the accessibility checklist for the public page and the new console screens; a persona walkthrough for a partner volunteer.

## 10. Build order (one task per commit, status in `layer-3-status.md`)

A. Migrations 0021–0026 + dictionary + retention + actions and template grants (partner roles get `shared.read`, `need.claim`, `referral.*`) + seed (sites, resources, contacts, ZIP centroids, a signed agreement with the cleanup partner). B. Sharing core: projections, grant derivation, revocation with recall notices, partner-scoped read API, text keyword for withdrawal. C. Needs board API, visibility, exports, key counts, needs-only public flow. D. Sites and resources API, publication log, public help endpoint, feeds, widget, media page, alert drafts. E. Channels: SHELTER/REFUGIO, voice read-out, resident updates and replies, referrals and notifications. F. Public "Find help" page with the optional map and the print views. G. Console screens 5–12. H. Worker jobs: grants, recall notices, site reconfirm reminders, resource review and link checks, publication fan-out, contact re-verification. I. Tests. J. Docs: ADR-0029 (maps), ADR-0030 (sharing model), ADR-0031 (public feeds), traceability, report, README, a11y records.

## 11. Deferred, with reasons

| IDs                                                                                                              | Why                                                                              | When              |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------- |
| REC-01–REC-14 (facility registry and recommendations)                                                            | rules and optimisation on top of sites and needs; AI explanations                | layer 7           |
| CON-03 map layers (reports, danger, outages, footprint, Census)                                                  | the map stack arrives now; the layers need missions, outages and Census profiles | layers 4 and 8    |
| CON-16 shelter registration, FL:FR-14/15 shelter workers and nurses                                              | field app and shelter workflows                                                  | layer 4           |
| FL-02 (find a record by phone), FL-09 (document photos), FL-13 (help received), FL:FR-07/11/12/18/23/25/27/29/30 | frontline and case-management workflows on the shared record                     | layers 4 and 6    |
| PUB-12 (social posts and graphics), PUB-14 (audio scripts and TTS)                                               | AI drafting and text-to-speech providers                                         | layer 7           |
| PUB-13 PDF                                                                                                       | the page ships now; PDF generation arrives with the FEMA package tooling         | layer 6           |
| NED-07 named case-management systems                                                                             | CSV and the documented API ship now; specific systems are a Section 21 open item | ask Adam          |
| CON-14 live conditions (outages, road closures, Waze, Google Maps)                                               | paid and external feeds                                                          | layer 8, ask Adam |
| FL:FR-32 (insurers: residents send their own summary)                                                            | the resident's own export from my report                                         | layer 6           |

## 12. Ambiguities resolved in the residents' favour (flagged for Adam)

1. **Minimum fields are a fixed table per service type** (NED-04), not a partner choice; a partner that needs more asks the resident through a referral, which the resident answers.
2. **Withdrawal is immediate** and partners get a recall notice that names what they held; exports already taken are the partner's obligation under the agreement.
3. **Confidential sites never leave the console**: not in feeds, widgets, texts, voice or print; staff refer in person.
4. **Nothing public without a named approver**, and a site past its confirmation window is hidden rather than shown stale; the public page says when each site was last confirmed.
5. **Needs without a report ask for a contact or a place but require neither**; the page says plainly that help cannot be sent without one.
6. **Resident updates go only to opted-in numbers and emails**, from approved templates or staff text that passes the output filter; replies are kept with the report, never forwarded to partners without a grant.
7. **The public page never says who is eligible** (RULE-12) and never shows availability a site lead has not confirmed (REC-10 spirit).
8. **Partner workspace users are partner tenants' own accounts** under their own realm (layer 1 tenancy), never county accounts with a partner role.

## 13. Gates claimed at the end of this layer

GATE-02 (AC-16, AC-17 and the NED/PUB cases above), GATE-03 for the public page (automated plus the record), GATE-04 (public routes reach only published, non-confidential records and the needs-only flow), GATE-06 (public page and feeds without credentials).
