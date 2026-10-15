# Common Ground — standing instructions for Claude Code

Common Ground is a disaster community-response platform built and sold by Mennelabs to county and city emergency management, NGOs (Salvation Army, Red Cross, VOADs) and states/regional coalitions. It covers resident damage and needs reporting, staff review, needs and partner sharing, public "Find help", missions and dispatch, a field app, FEMA declaration support, a CJIS enclave, ICS/EOC functions and AI assistance.

Read this file at the start of every session. It holds the rules that stay true for the whole build.

## Source of truth

All requirements are in `docs/`:

| File | What it is |
| --- | --- |
| `docs/00-original-BRD-FRD.txt` | The original Emergency Management Application Rebuild BRD/FRD. **The foundation.** Its system-wide rules apply everywhere: FR-00.01–10, RULE-01–18, AI-01–12, F01–F18, NFR-01–12, INT-01–07, MIG-01–09, launch gates GATE-01–10, decision register DEC-01–22. |
| `docs/01-requirements-main.md` | Sections 11–30: intake (INT), photos (PHO), channels (CHN), needs (NED), equity (EQ), security (SEC), AI governance (AIG), scale (SCL), metrics, declaration support (DEC), public information (PUB), **Section 29 reconciliation**, Section 30 recommendations, Section 21 open decisions. |
| `docs/02-console-scenario.md` | Staff console scenario (WESTWIND exercise), CON-01–17, REC-01–14. |
| `docs/03-field-and-dispatch.md` | Field app FLD-01–17, dispatch DSP-01–13. |
| `docs/04-frontline-roles.md` | Frontline worker cast FL-01–18, 12 hand-offs, features FR-01–32. |
| `docs/05-fema-field-mapping.md` | Data element → FEMA form/field mapping (PDA/IDA, FEMA 010-0-13, street/tick/summary sheets, narrative), DEC-17. |
| `docs/06-sms-and-phone-setup.md` | Twilio toll-free verification answers, message templates, keywords, county privacy/terms text, IVR flow. |
| `mockups/resident/*.dc.html`, `mockups/console/*.dc.html` | UI direction for the resident intake and the staff console / dispatch / field screens. Source markup from a design canvas (it will not render standalone; read it for layout, content and flow). Direction, not pixel specs; accessibility rules win over any mockup. |

How to read them:

- Every ID is a testable requirement. **Must** = release-blocking, **Should** = planned, **May** = optional.
- Where documents conflict, Section 29 decides. Anything not covered there: the stricter rule wins.
- Decisions dated 2026-10-12 supersede older text. Known stale line: Section 21 says "CJIS: design the enclave now, build later" — superseded. **The CJIS enclave is built for release 1 (SEC-12).**
- Cite requirement IDs in code comments, tests, commit messages and PRs so every ID is traceable.

## Fixed decisions (do not revisit without asking Adam)

- **Name:** the product name is one config value, `PRODUCT_NAME`, currently "Common Ground" (ADM-03). Never hardcode it. Resident texts and calls use the county's name, not the product name.
- **Scope:** disasters only (DEC-01). Release 1 = everything in the docs (SCL-14).
- **Hosting:** Docker on Docker Desktop now, one `docker compose up` for the whole system (SCL-11). Same images later move unchanged to a FedRAMP/GovRAMP-authorized government cloud. Every cloud dependency sits behind an adapter with a local stand-in: PostgreSQL + PostGIS, S3-compatible storage (MinIO locally), secrets/keys (local vault → cloud KMS), a standard message queue. Configuration only from environment variables and secrets.
- **Stack:** you choose language, frameworks, database libraries, queue and React Native libraries. Record each choice as an ADR in `docs/adr/` (what, alternatives, why it fits SCL-11 and the gov-cloud move) (SCL-15).
- **Field app:** React Native (background GPS, offline maps, MDM, help button). Residents use the no-install mobile web app.
- **Maps:** MapLibre (web and React Native) + OpenStreetMap data. Tiles and geocoding self-hosted in containers; parcel data loaded per tenant; offline packages cut from the self-hosted tiles. Esri/FEMA tools via import and export; public reference data (census, structures, flood zones, declarations and the like) may also be pulled live from free services, with file import for every dataset (decision 2026-10-14, ADR-0039; SCL-09, SCL-13). USNG coordinates supported.
- **AI:** pluggable (AIG-12). One internal interface each for LLM, speech-to-text, translation and image analysis; provider chosen per tenant in config. A provider can be enabled only if US-processing, zero-retention, no-training (AIG-06) and it passes the evaluation suite for that tenant's languages (AIG-08). Every AI output records provider and model. Ship a deterministic fake provider for development and tests. Follow OWASP LLM Top 10. **Updated 2026-10-15 (`docs/decisions.md`):** the provider is OpenAI for every AI function until a cloud provider is chosen; running systems never use the fake provider (it stays a test double in automated tests); AI health alerts but does not switch features off.
- **Photo damage suggestion:** a purpose-trained classifier behind a swappable inference interface (PHO-12); the university partner model does not exist yet. Build the interface, the human decision workflow and the evaluation harness; keep the severity suggestion switched off until a validated model is plugged in. A general vision-LLM may coach photo quality but never supplies a severity rating. **A human always decides.** **Updated 2026-10-15 (`docs/decisions.md`):** the severity suggestion now comes from OpenAI's vision model, labelled as an unverified AI suggestion; a credentialed reviewer still always decides.
- **Permissions:** fully configurable per county from shipped role templates, with versioning, audit and a "what can this role do" preview (ADM-04). Guardrails no county can turn off (ADM-05): default deny with server-side checks; public users never see private records; criminal-justice data only for CJIS-qualified users; no approving your own finding without an audited exception; nobody can edit or delete audit records; granting permissions needs a second administrator; restricted health, counseling and legal fields stay limited to their roles.
- **Languages:** English and Spanish at launch, every resident and public string translatable; more languages later via tenant config.
- **Retention (SEC-13):** tenant-configurable; default 7 years. Exceptions: scribe audio deleted once the note is confirmed; live position trails 30 days; personal command conversations 30 days; CJIS data per CJIS and state records rules. Legal holds override deletion.
- **Danger flags:** awareness only. Never dispatch-like. The resident is shown "If this is an emergency, call 911" (CON-10).
- **SMS/phone:** Twilio, one verified toll-free number per county, use cases CUSTOMER_CARE + PUBLIC_SERVICE_ANNOUNCEMENT, IVR via Twilio Studio. Use the keywords and templates in `docs/06`. Never use "emergency alert" style wording in SMS (carrier rejection). Keyword AYUDA is the Spanish HELP keyword; shelter lookup is REFUGIO.
- **FEMA outputs:** federal forms only, no state forms (DEC-17, `docs/05`). Low-income figures are reported as Census aggregates, not individual data.
- **Compliance targets:** GovRAMP Moderate (NIST 800-53 Moderate controls), SOC 2, CJIS Security Policy v6.x for the enclave, WCAG 2.2 AA minimum for every released screen.

## Non-negotiable development rules

1. **Synthetic or exercise data only** on laptops and in the repo. Never real resident or criminal-justice data (SCL-12). Build a seed generator for a realistic fictional county (the WESTWIND exercise in `docs/02` is a good basis).
2. **CJIS enclave = its own container set**: separate network, database, keys, identity and audit. It holds no real CJI until it is in an authorized gov cloud and has passed the state CJIS audit.
3. Webhooks (Twilio etc.) reach a laptop only through a secured development tunnel.
4. **Build order is SCL-14.** Do not start a layer until the previous one passes its acceptance cases and the applicable GATEs:
   1. Foundations: tenancy hierarchy, events, identity/MFA, configurable permissions + guardrails, audit, save/retry/idempotency (FR-00, SEC, ADM-03/04/05)
   2. Resident intake (web, SMS, IVR, assisted/kiosk), review queue, verification
   3. Needs board, partner sharing with consent, public "Find help" (PUB)
   4. Missions, dispatch board, React Native field app (offline, GPS)
   5. CJIS enclave
   6. FEMA package and official reports
   7. AI features: scribe, photo pre-sort, recommendations, resource discovery, command window
   8. ICS forms and EOC functions
5. **Before each layer:** write a short plan in `docs/plans/layer-N.md` listing the requirement IDs covered, data model changes, APIs, screens, tests and which IDs are deferred and why. Then build.
6. **After each layer:** a traceability table (`docs/traceability.md`) mapping every requirement ID in the layer to code and tests, with pass/fail. Report what passed, what failed and what is deferred.
7. **Tests are part of done:** unit, integration, end-to-end for each public and staff task, automated accessibility checks (axe or equivalent) plus a manual checklist per screen, security tests for permission boundaries and guardrails, and load tests toward SCL-03 (50,000 submissions/hour, 10,000 concurrent SMS sessions) once intake exists.
8. **Never fail a resident submission.** Intake writes are queued; graceful degradation order: AI off → photo processing deferred → maps off → text reports still accepted (SCL-06).
9. **Security by default:** encryption in transit and at rest, field-level protection for restricted data, secrets never in code or logs, dependency and container scanning in CI, structured audit for every read of restricted data and every write.
10. **Ask Adam before:** deviating from a Must requirement, changing a fixed decision above, adding a paid third-party service, or building anything still open in Section 21 (pilot tenant, case-management integrations, badge printers, command-window defaults in Section 30.2 — use the recommended defaults behind a config flag until approved).

## Working style

- Small, reviewable commits that cite requirement IDs.
- Keep `README.md` current: how to start the stack, seed data, run tests, and where things live.
- When a requirement is ambiguous, pick the reading that best protects residents' privacy and safety, note it in the layer plan, and flag it in your report.

## Resuming work (any session)

1. Read `docs/plans/layer-N-status.md` for the current layer (layer 1 first). It lists what is done with commit SHAs, what is next, and the open issues. Chat history is not the record.
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name`. Do not build on a red tree.
3. Work one task at a time. A task ends with green checks, a commit that cites requirement IDs, an updated status file, and a push. Never leave more than one task's work uncommitted.
4. Decisions from Adam go into `docs/decisions.md` with the date before the code that depends on them is written.
5. New database columns go into `packages/db/src/dictionary.ts` in the same migration (SEC-11); the migration fails otherwise.
