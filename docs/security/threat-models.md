# Threat models, one per feature (SEC-15)

SEC-15 asks for a threat model for each feature. This page holds them. Each feature lists who uses it, what an attacker could want, the threats sorted by STRIDE category, the control in place with the code or test that proves it, and what risk remains.

- **STRIDE categories:** spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege.
- **Review rule:** a feature that changes who can reach data, or what data it holds, updates its section in the same pull request. The section names the requirement IDs it covers.
- **Written:** 2026-10-16, against the code as it stands on `main` plus the open layer-7 follow-ups.

Controls that every feature relies on are described once, in "Shared controls" below. The per-feature sections refer back to them by letter (A to H).

## Shared controls

| ID  | Control                                                                                                                                                                                                                                                                                                                                     | Where it is proven                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A   | **TLS everywhere.** Every response carries HSTS, nosniff and `Referrer-Policy: no-referrer`. Pages carry a CSP with `frame-ancestors 'none'` and no inline or eval script. Plain HTTP is redirected, never served.                                                                                                                          | `infra/caddy/Caddyfile`; `tests/e2e/dast.spec.ts`                                                                                 |
| B   | **Staff identity.** Keycloak signs staff in, with passkeys required as the second factor (ADR-0008). The API checks access tokens against the realm's keys. Every `/api/v1` route refuses a request without a signed-in account at the start of the request, before any body is parsed or validated. A forged or unsigned token is refused. | `services/api/src/plugins/context.ts`, `services/api/src/app.ts`; `tests/e2e/dast.spec.ts`, `tests/e2e/console.spec.ts` (passkey) |
| C   | **Default-deny authorization** in our own policy engine (ADR-0011), checked on the server. Guardrails no county can switch off (ADM-05): no approving your own finding, a second administrator for grants, restricted fields limited to their roles. Consequential actions need a named person and a reason; a missing reason gets a 428.   | `packages/authz`; `services/api/test/authz-sweep.db.test.ts`                                                                      |
| D   | **Tenant isolation.** Row-level security is forced on every tenant table (`cg.apply_tenant_rls`), and each request runs inside its tenant's context. A partner reads another tenant's data only through what a share grant covers.                                                                                                          | `packages/db` migrations; `pnpm --filter @cg/db check:migrations` lists tables without RLS (none)                                 |
| E   | **Field-level encryption.** Restricted fields (contact details, restricted answers, names on passes, signatures) are encrypted per tenant with keys held in the vault stand-in (cloud KMS later). Reading them is audited.                                                                                                                  | `packages/crypto`; per-feature DB tests check that stored bytes hold no plain text                                                |
| F   | **Audit.** A hash-chained audit log, verified by the worker every 15 minutes. Nobody can edit or delete audit rows. Every write and every read of restricted data is recorded.                                                                                                                                                              | `services/api/test/auditchain.db.test.ts`                                                                                         |
| G   | **Optimistic concurrency and idempotency.** Writes carry `If-Match` and an `Idempotency-Key`, so a stale or replayed write is refused or answered once.                                                                                                                                                                                     | `services/api/src/plugins/versions.ts`, `idempotency.ts`                                                                          |
| H   | **Supply chain.** Actions are pinned to commit SHAs (ADR-0019). Semgrep (SAST), Trivy dependency and image scans, SPDX SBOMs and these dynamic checks run on every push.                                                                                                                                                                    | `.github/workflows/ci.yml`                                                                                                        |

## 1. Resident intake: web, kiosk and assisted (INT, PHO, CHN-01)

- **Who uses it:** anyone, with no account.
- **What an attacker wants:** to flood the queue, plant false damage, read other residents' reports, or run script in a staff browser.

| STRIDE | Threat                                                           | Control                                                                                                                                                | Residual                                                                                                        |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| S      | Fake reports from bots                                           | Abuse risk scoring holds suspicious reports for review rather than dropping them; per-address windows                                                  | A determined human can still send a false report. Verification (staff, then field) catches it before it counts. |
| T      | Answers that do not fit the question graph; replayed submissions | Answers are validated against the published graph version; one execution id gives one report (G)                                                       | —                                                                                                               |
| R      | "I never sent that"                                              | The execution id and reference code are kept with the report; a correction keeps the earlier version (RULE-09)                                         | —                                                                                                               |
| I      | Reading someone else's report                                    | Restricted answers are encrypted (E). The reference code alone shows nothing: My report needs a one-time code sent to the contact on file (section 3). | —                                                                                                               |
| D      | Flooding intake                                                  | Intake writes are queued and never fail a resident (SCL-06); the load tests target SCL-03                                                              | Cloud-level rate limiting comes with the government-cloud move (SCL-05).                                        |
| E      | Reaching staff routes                                            | Public routes live under `/api/public` with the public subject; `/api/v1` refuses them at the start of the request (B)                                 | —                                                                                                               |

## 2. Photos (PHO, CHN-09)

- **Who uses it:** residents, and field and staff users through their own routes.
- **What an attacker wants:** to upload malware or huge files, leak a resident's location through EXIF data, or read other people's photos.

| STRIDE | Threat                                 | Control                                                                                                                                                  | Residual                                                                                                                   |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| T      | Malformed or hostile files             | Size capped before the ticket and checked again on completion. The worker decodes and re-encodes every image, which drops everything that is not pixels. | There is no antivirus scan (BRD:INT-03). Re-encoding removes embedded payloads from images; non-image uploads are refused. |
| I      | Location and camera metadata           | Stripped on the device and again by the worker. Suggested time and place are kept as suggestions only.                                                   | —                                                                                                                          |
| I      | Reading photos                         | Never served from a storage link: staff routes check the person's role; upload links are presigned for 15 minutes and write-only.                        | —                                                                                                                          |
| E      | Adding photos to someone else's report | My report's upload ticket needs the resident token for that report; the photo is tied to that report's submission                                        | —                                                                                                                          |

## 3. My report and lookup (RES-01/02, SEC-09, RULE-17)

| STRIDE | Threat                                       | Control                                                                                                                                                             | Residual |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S      | Guessing a reference number to read a report | The same answer whether or not the details match. A six-digit code is sent to the contact on file, with at most five tries per code and a window limit per address. | —        |
| S      | Stolen resident token                        | Signed with HMAC, bound to one tenant and one report, valid 30 minutes, kept in session storage only                                                                | —        |
| I      | Contact details shown back                   | Never shown; the PDF copy leaves out how to reach them, household and needs                                                                                         | —        |

## 4. Text and phone channels (CHN, docs/06)

| STRIDE | Threat                                | Control                                                                                                                                                                 | Residual                                                                |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| S      | Forged webhooks posing as the carrier | Twilio's signature is checked on every webhook (`services/api/src/channels/twilio.ts`); webhooks reach a laptop only through a secured tunnel                           | —                                                                       |
| I      | Messages and contacts in logs         | Request bodies are not logged; the logger redacts phone, email, name and address fields, credentials and the carrier's signature header (`services/api/src/logging.ts`) | —                                                                       |
| D      | Text flooding                         | STOP and HELP are honoured; a conversation is one session per number                                                                                                    | Carrier-side filtering applies; per-number throttling is the carrier's. |

## 5. Staff console and API (CON, ADM, NED, MIS, DSP)

| STRIDE | Threat                             | Control                                                                                                  | Residual                                                                        |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| S      | Account takeover                   | Passkeys required; break-glass access is time-boxed and audited (B, F)                                   | Phishing-resistant only once passkeys are enrolled; TOTP is a tenant exception. |
| T      | Lost updates and replays           | G                                                                                                        | —                                                                               |
| R      | Denied actions                     | Consequential actions carry a named person and reason (C); audit (F)                                     | —                                                                               |
| I      | Over-broad reads                   | Field-level access in each response; restricted reads are audited; partners see only what was shared (D) | —                                                                               |
| E      | Self-approval and privilege grants | ADM-05 guardrails (C): granting needs a second administrator; nobody approves their own finding          | —                                                                               |

## 6. Partner sharing and Find help (NED, PUB)

- **Partner sharing:** a partner sees a projection of a shared need, limited to the resident's consent per organization type. It is synchronised when consent or the report changes (NED-04), and withdrawn when consent is withdrawn.
- **Find help** serves published, non-confidential records only. Pages carry a strict CSP. Resource pictures are re-encoded and public only from the publish that approved them (BRD:FR-16.01). Health notices need a second approver (FL:FR-06).
- **Residual risk:** a site's address is public by design. Confidential sites (domestic-violence shelters) are never published.

## 7. Field app (FLD, DSP-07/08, SEC-10)

| STRIDE | Threat                            | Control                                                                                                           | Residual                                                            |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| S      | A lost phone used by someone else | PIN to open; administrators can wipe it remotely, and the wipe rides along on the next sync                       | Screenshot blocking and MDM configuration are not built (FLD-02).   |
| I      | Data on a lost phone              | Encrypted local stores, purged after sync; positions recorded only while checked in; position trails kept 30 days | The stores are checked on a device by a person, not in CI (NFR-08). |
| T      | Conflicting offline edits         | Outbox with client ids; a second record for the same property is flagged, never merged                            | —                                                                   |

## 8. CJIS enclave (SEC-12)

- **Separation:** the enclave is its own set of containers, with its own network, database, keys, identity and audit.
- **What the platform holds:** only a random opaque reference per mission. Bodycam media are refused on the platform side.
- **Threats covered:** a platform compromise does not reach the enclave's data. Enclave sign-in is separate and checks its CJIS values (ADR-0036).
- **Residual risk:** the enclave holds no real CJI until it runs in an authorized government cloud and passes the state CJIS audit.

## 9. AI features (AIG, OWASP LLM Top 10)

| Risk                                     | Control                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection (LLM01)                 | Text that tries to instruct the model is detected and refused (for example the `injectionSuspected` flag). The command window runs only catalogued commands, and every plan is confirmed by a person. |
| Sensitive information disclosure (LLM06) | Names are redacted before text reaches the provider. The provider must process in the US, retain nothing and not train on the data (AIG-06).                                                          |
| Excessive agency (LLM08)                 | The AI drafts, suggests or interprets; a person decides. No AI output changes a record by itself.                                                                                                     |
| Overreliance (LLM09)                     | Every output records its provider and model, and is labelled as AI. Severity suggestions are marked unverified, and a credentialed reviewer decides.                                                  |
| Model denial of service and cost (LLM04) | Timeouts and deadlines; AI health alerts; features degrade to manual work (SCL-06).                                                                                                                   |

## 10. Command window (CMD)

- **Plan, then confirm:** each plan is checked against a hash before it runs. Commands are switched on in phases per county (Section 30.2), and batch limits apply.
- **Free text** a person typed is kept only as a digest after the command runs (CMD-37).
- **Places:** finding a mission by its place needs the right to read mission locations (DSP-04).

## 11. Outbound integrations (SCL-09): API keys, webhooks, feature service, Waze feed

| STRIDE | Threat                                                             | Control                                                                                                        |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| S      | Forged deliveries to a county's systems                            | Webhooks are signed with HMAC-SHA256 over the timestamp and body (`packages/adapters/src/webhooks.ts`).        |
| I      | Leaked API keys                                                    | Keys are shown once and stored hashed. Each key is scoped to its feature service and can be revoked.           |
| E      | Server-side request forgery through link checks or webhook targets | Only public addresses on web ports are allowed, with DNS pinned (`isPublicAddress`, `pinnedLookup`, ADR-0042). |
| I      | Waze feed                                                          | Public road information only, off until the county switches it on (FL:FR-05).                                  |

## 12. Credentials at the perimeter: badges and re-entry passes (BDG, FL:FR-03)

- **Codes** are shown once and stored only as a hash.
- **What a scan shows:** a revoked, expired or not-yet-valid pass shows nobody's name. The holder and home are shown only to the role that checks passes.
- **Audit:** every scan is logged with its checkpoint, naming no one.

## Dynamic testing (DAST)

`tests/e2e/dast.spec.ts` runs against the live stack on every push, as part of the end-to-end suite. It checks:

- the headers on every page;
- the redirect from HTTP to HTTPS;
- missing, forged and unsigned tokens on staff routes, which must get the error envelope and no internals;
- malformed and hostile input, which must not produce stack traces or database text;
- cross-origin requests, which must never be granted;
- TRACE requests and path traversal;
- the identity provider refusing to redirect a sign-in to an unknown address.

The first run found that a staff route with a required query parameter answered a request with no token with a validation error. That error described the route to an outsider. Such requests are now refused at the start of the request (B).

A full ZAP baseline scan is not run here: the build environment cannot fetch the ZAP image. It is the next step for CI, as a report-only job.

## Not done yet

- **Signed release builds and an SBOM per release (SEC-15).** There is no release workflow yet; SBOMs are built on every push.
- **Antivirus scanning of uploads (BRD:INT-03).**
- **Cloud-level controls arrive with the government-cloud move:** WAF and rate limiting, volume encryption, service mTLS, and KMS in place of the vault stand-in.
