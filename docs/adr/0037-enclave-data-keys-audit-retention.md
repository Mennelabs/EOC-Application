# ADR-0037: Enclave data, per-agency keys, its own audit chain, retention and worker

- Status: accepted
- Date: 2026-10-14
- Requirements: SEC-12, PPL-01, SEC-10, SEC-11, SEC-13, SEC-18, ADM-05, BRD:FR-07.01–07.06, BRD:FR-04.01, BRD:FR-08.04, FR-00.05, FR-00.06, ADR-0006, ADR-0009, ADR-0012, ADR-0021

## Decision

**Its own database package.** `packages/cjis-db` holds the enclave schema `cjis`, its migrations (`0001_foundation` … `0005_subject_lookup`), its data dictionary and its migration drill. It shares no code path with `packages/db`; the patterns are the platform's (ADR-0005, ADR-0006, ADR-0012) re-implemented inside the boundary.

- **Tenant is the agency.** Every table that carries `agency_id` has row security forced; the API sets `app.agency_id` and `app.person_id` per transaction (`withAgency`). Three database roles: `cjis_migrator` (owner), `cjis_app` (the API; agency-scoped), `cjis_job` (the worker; system jobs only). Before the agency is known, a request can read only the account its token names (`app.subject`, migration 0005).
- **The record** is keyed by (agency, `cji_ref`), where `cji_ref` is the platform's opaque value (checked `^[A-Za-z0-9_-]{32,64}$`). It holds origin, classification, offense codes, case number, summary, disposition with recorder and reviewer (BRD:FR-07.05); people involved in law-enforcement roles, recorded once, only here (PPL-01, BRD:FR-07.02); weapons (BRD:FR-04.01); body-camera references only, never media (BRD:FR-07.04); an append-only timeline of time-stamped events, narratives and attributable amendments (BRD:FR-07.01, BRD:FR-07.03). Every write checks an expected version (FR-00.05); creates take an idempotency key and store the response encrypted (FR-00.06).
- **Every column is in the enclave dictionary** with its classification (`cji`, `restricted`, `internal`, `public`); the drill fails on an undocumented or stale column and on a table without forced row security (SEC-11).

**Keys (SEC-10).** Each agency has a 256-bit data key, generated in the enclave's OpenBao (`cjis-keys`) and stored wrapped by that agency's transit key (`cjis.agency_key`). Identifying and free-text values (names, identifiers, case numbers, summaries, narratives, serial numbers, evidence references) are sealed with AES-256-GCM, with the agency id as additional data, so a value copied to another agency's row does not open. The platform's keys never see enclave data and the enclave never sees the platform's keys.

**Audit (SEC-18, BRD:FR-08.04, ADM-05).** The enclave writes its own hash-chained audit: each event takes the chain lock, draws its sequence and links to the previous hash. Every read of a record (with the field names read, never values), every write, every denial and every sign-in event is recorded. No role can update or delete an audit row (grants and a trigger); `cjis.verify_audit_chain()` recomputes the chain and the security officer can run it, export a CSV and record the weekly review (`audit_review`, AU-6).

**Retention (SEC-13).** `retention_policy` per agency and category with floors in the schema: records at least one year after closure, audit at least seven years. Default seven years for both until the agency enters its state records schedule. `legal_hold` overrides deletion; each deletion writes a `deletion_log` row and an audit event.

**Worker.** `cjis-worker` (same image as the API, `cjis_job` role, the identity provider's admin client) runs four jobs: the identity outbox (create, enable, disable identities after the database decides), copying sign-in events from Keycloak into the audit (AU-2), the retention sweep honouring holds, and suspension after 90 days without a sign-in (AC-2). The API holds neither the job role nor the admin secret.

## Alternatives considered

| Option                                         | Why not                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Reuse `packages/db` with a second connection   | One migration history and dictionary for both sides invites a platform column holding CJI; fails SEC-12. |
| Database-level encryption only (pgcrypto, TDE) | Keys would sit with the database; per-agency keys outside the database survive a database copy.          |
| Write enclave audit to the platform's chain    | The platform would hold who looked at which CJI record; the audit must stay inside the boundary.         |
| A queue in the enclave for the worker          | Four periodic jobs and an outbox table do the work without another container to authorize.               |

## Why it fits SCL-11 and the government-cloud move

The enclave database becomes a managed PostgreSQL in the authorized account; OpenBao transit is replaced by that account's FIPS 140-validated KMS behind the same key-store interface; the worker's jobs run unchanged. Anchoring the audit chain to object-locked storage moves with the cloud (layer-5 plan §11).

## Consequences

Searching encrypted fields needs decryption in the API; the enclave lists records by reference, classification, state and dates only. `packages/cjis-db/test/enclave.db.test.ts` (row security, the role checks, the chain under tampering, floors and holds) and `services/cjis-api/test/api.db.test.ts` run in CI on a throwaway enclave database, followed by the enclave migration drill.
