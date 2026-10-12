# Layer 1 plan: platform foundations

Status: proposed, waiting for Adam's approval of the first deliverables. Build order per SCL-14 (1). Nothing in layer 2 starts until every acceptance case below passes and GATE-01, GATE-04 and GATE-05 are met.

Scope in one sentence: the tenancy hierarchy, events, staff identity with MFA, configurable permissions with hard guardrails, the audit log, save/retry/idempotency rules, and the data-protection plumbing (classification, field encryption, retention) that every later layer calls.

## 1. Requirement IDs covered

From `docs/requirements-index.md`, layer 1 plus the cross-cutting IDs first proven here. Class is Must unless noted.

| Group                                        | IDs                                                                                                                                     | Built as                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Authorization and public boundary            | BRD:FR-00.01, FR-00.02, SEC-06, ADM-04, ADM-05, AC-00A, AC-01B, AC-C03, AC-C05                                                          | Policy engine, guardrails, role templates, role editor API, "what can this role do" preview                                |
| Identity                                     | SEC-07, SEC-08, BRD:FR-01.01–01.06, BRD:INT-01, ACCT-01, AC-01A, AC-01C                                                                 | Keycloak realm per tenant, SSO brokering, passkeys, break-glass, account/personnel split                                   |
| Audit                                        | BRD:FR-00.03, FR-08.01–08.05, SEC-18, RULE-07, RULE-15, AC-08A–C, AC-18A                                                                | Append-only hash-chained `audit_event`, verifier job, anchors                                                              |
| Save, concurrency, idempotency, errors, time | BRD:FR-00.04–00.08, AC-00B, AC-00C, AC-00D, RULE-02                                                                                     | Fastify plugins: `Idempotency-Key`, `If-Match` versions, error envelope, UTC storage, unknown-vs-zero types                |
| Tenancy, events, licensing                   | SCL-01, SCL-02, SCL-07, SCL-10, BRD:FR-18.01–18.06, BRD:DEC-03                                                                          | `tenant`, `jurisdiction`, `license`, `data_sharing_agreement`, `tenant_config`, `event`, `event_participant`               |
| Isolation                                    | SEC-05, BRD:FR-18.06                                                                                                                    | RLS on every tenant table, per-tenant storage prefixes and keys, cross-tenant test suite                                   |
| Data protection                              | SEC-10, SEC-11, SEC-04, SEC-13, SEC-14, NFR-03                                                                                          | Data dictionary with classifications, envelope encryption, blind indexes, retention policies and deletion job, legal holds |
| Configuration and naming                     | ADM-03, SCL-11, SCL-12, SCL-15, BRD:FR-00.10, BRD:FR-18.05                                                                              | Typed config, product-name check, governed definitions table with versions                                                 |
| Secure SDLC and operations                   | SEC-15, SEC-01 (design), SEC-19 (hooks), NFR-02, NFR-04, NFR-05, NFR-10, NFR-11, BRD:INT-03                                             | CI scans (done in scaffold), backup/restore script and drill, alert hook, structured logs                                  |
| Admin                                        | ADM-01 (users, roles, partner organizations, data-sharing agreements, event templates), ADM-02 (model only; onboarding flow in layer 3) | Administration workspace, first console screens behind sign-in                                                             |
| Accessibility baseline                       | NFR-01, FR-A01–A03, ACC-04–10, AC-A02 on every layer-1 screen                                                                           | Shared `packages/ui`, axe + manual checklist                                                                               |
| Gates                                        | GATE-01, GATE-04, GATE-05                                                                                                               | Evidence in `docs/traceability.md`                                                                                         |

Deferred out of layer 1 (with reason):

| IDs                                             | Why                                                                                                                    | Where                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| SEC-02, SEC-16, SEC-19 (drills), SCL-05, AIG-11 | Compliance programmes and multi-region availability need the government cloud and an auditor; code hooks are built now | `Process` / `Gov` in the index |
| MIG-00–09                                       | No source system (finding C-04)                                                                                        | Deferred                       |
| ADM-02 onboarding flow                          | Needs needs-sharing and partner workspace                                                                              | Layer 3                        |
| Public resident lookup (SEC-09, RES-01)         | Needs reports                                                                                                          | Layer 2                        |
| CJIS identity                                   | Enclave built in layer 5; skeleton isolation already proven                                                            | Layer 5                        |

## 2. Data model changes

Migrations `0002`–`0012` in `packages/db/src/migrations`, all in schema `cg`:

1. `tenant` (ltree `path`, kind, timezone, locales, status), `jurisdiction` (PostGIS multipolygon), `license`, `data_sharing_agreement`, `tenant_config` (versioned JSON by key).
2. `event`, `event_participant`, `event_template`.
3. `account`, `personnel` (separate, nullable link, FR-01.05), `account_lifecycle` history.
4. `role` (versioned), `role_grant`, `role_assignment`, `permission_change_request` (two-administrator rule), `break_glass_session`.
5. `audit_event`: append-only (grants: INSERT/SELECT only for `cg_app`; trigger rejects UPDATE/DELETE/TRUNCATE for all but `cg_migrator`), per-tenant hash chain, `audit_anchor`.
6. `data_dictionary` (table, column, classification, retention category) populated by every migration that adds columns; a test fails when a column is missing from it.
7. `tenant_key` (wrapped per-tenant data keys), `retention_policy`, `legal_hold`, `deletion_log`.
8. `idempotency_key` (scope, key, request hash, response, expires), `governed_definition` (FR-00.10, versioned).
9. `outbox` (ADR-0007) relayed by the worker.
10. RLS: `ENABLE` + `FORCE ROW LEVEL SECURITY` on every tenant table; policy `tenant_id = current_setting('app.tenant_id')::uuid`, plus hierarchy-read policies that consult `data_sharing_agreement` for de-identified aggregates.

Every table: `id uuid`, `tenant_id`, `version int`, `created_at/by`, `updated_at/by`. Timestamps `timestamptz` in UTC (FR-00.08). Unknown values use nullable columns plus explicit `*_known` flags where "unknown" and "zero" both matter (RULE-02).

## 3. APIs

All under `/api/v1`, OpenAPI generated from zod schemas, every route wrapped by: auth → policy decision → transaction with `SET LOCAL app.*` → audit.

| Area                   | Endpoints                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session                | `GET /me` (account, tenant, active roles, break-glass state)                                                                                                                                                                                                             |
| Tenants                | `GET/POST /tenants`, `GET/PATCH /tenants/{id}`, `GET /tenants/{id}/children`, `PUT /tenants/{id}/config/{key}` (versioned), `GET/POST /tenants/{id}/agreements`                                                                                                          |
| Events                 | `GET/POST /events`, `PATCH /events/{id}` (open/close with reason), `POST /events/{id}/participants`                                                                                                                                                                      |
| Accounts and personnel | `GET/POST /accounts`, lifecycle transitions (`invite`, `activate`, `suspend`, `deactivate`), `GET/POST /personnel`, `POST /personnel/{id}/link-account`                                                                                                                  |
| Roles                  | `GET /role-templates`, `GET/POST /roles`, `POST /roles/{id}/versions`, `POST /roles/{id}/preview` ("what can this role do"), `POST /role-assignments` → creates a `permission_change_request`; `POST /permission-change-requests/{id}/approve` by a second administrator |
| Break-glass            | `POST /break-glass` (reason, duration), auto-expiry, notification to tenant security contact                                                                                                                                                                             |
| Audit                  | `GET /audit` (filter by tenant, actor, target, time; itself audited), `GET /audit/verify` (chain check result)                                                                                                                                                           |
| Definitions            | `GET/PUT /definitions/{key}` (FR-00.10, versioned, audited)                                                                                                                                                                                                              |
| Platform               | `/health/*`, `/api/meta` (exists)                                                                                                                                                                                                                                        |

Headers: `Idempotency-Key` required on every POST that creates (FR-00.06); `If-Match: <version>` required on PATCH/PUT (FR-00.05), `409` with current state on conflict (AC-00B). Error envelope `{ code, message, fields[], retryable }` (FR-00.07).

## 4. Screens (console, after sign-in)

1. Sign-in via Keycloak (tenant realm, passkey enrolment on first login) and access-denied page.
2. Administration workspace: tenants and hierarchy, events (open/close), accounts and lifecycle, personnel, partner organizations and agreements.
3. Roles: template list, role editor (action × scope × data category), version history, "what can this role do" preview, pending permission changes awaiting a second administrator.
4. Audit viewer with filters and chain-verification status.
5. Break-glass request and banner while active.

Each screen: WCAG 2.2 AA, axe in Playwright, manual checklist record in `docs/a11y/screens/`, English only for staff screens in layer 1 (Spanish staff UI is a tenant option later; resident strings are EN/ES from layer 2).

## 5. Seed and tooling

- Seed loader (`tools/seed`): writes the WESTWIND tenants, events, role templates, cast accounts and personnel into the database and the Keycloak realm (passkeys cannot be seeded; dev realm allows a one-time enrolment code).
- Keycloak realm template in `infra/keycloak/realm-template.json`, applied per tenant by the API using the admin client.
- `scripts/backup.sh` / `scripts/restore.sh` for Postgres and MinIO with a documented drill (NFR-05).

## 6. Tests

| Kind                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (`packages/authz`) | One file per guardrail (ADM-05 1–7), role evaluation, field masks, preview equals runtime decision                                                                                                                                                                                                                                                                                                                             |
| Unit (`packages/audit`) | Hash chain, canonicalization, verifier detects a mutated row                                                                                                                                                                                                                                                                                                                                                                   |
| Integration             | RLS: for every tenant table, a subject in tenant A reads zero rows of tenant B via API and via direct SQL as `cg_app` (SEC-05); audit role cannot UPDATE/DELETE (FR-08.04); idempotent create (AC-00C); stale version conflict (AC-00B); failed save gives no success (AC-00D); deactivated account denied on next action (AC-01A) with attribution kept (AC-01C, AC-08B); two-admin rule; break-glass expiry and notification |
| Security                | Guardrail bypass attempts through every entry point: direct API, prepared action replayed after permission revoked (AC-C05), public subject enumerating private records (AC-C03), self-approval (AC-12B shape, with a stub finding)                                                                                                                                                                                            |
| E2E + axe               | Sign-in with passkey (virtual authenticator), role editor flow, audit viewer; phone and desktop                                                                                                                                                                                                                                                                                                                                |
| Load (smoke)            | 200 req/s on `/me` and role preview to catch N+1 policy loads; full SCL-03 load tests begin in layer 2                                                                                                                                                                                                                                                                                                                         |
| Restore drill           | Backup, destroy, restore, verify audit chain still validates (NFR-05, GATE-09 recovery half)                                                                                                                                                                                                                                                                                                                                   |

## 7. Acceptance for closing layer 1

- Every ID in section 1 maps to code and a passing test in `docs/traceability.md`.
- GATE-01: public role list (A–F, S29) and permission boundaries documented in the role templates.
- GATE-04: security suite finds no bypass.
- GATE-05: idempotency, concurrency and consistency tests pass.
- `docker compose up` still brings every service to healthy from clean volumes, with the seed loaded.

## 8. Ambiguities resolved in the resident-protective direction (flagged for Adam)

1. **Who counts as "a second administrator"** for permission grants: any other account holding the tenant-admin role, never the requester, and never a break-glass session. Both approvals are audited.
2. **Break-glass scope (SEC-08):** reads only, time-boxed (default 4 hours), every read audited as restricted, no permission changes while active.
3. **Retention default (SEC-13)** applies to audit as 7 years minimum; tenants may lengthen, never shorten below 7 years for audit.
4. **Staff MFA fallback:** TOTP only by tenant policy exception, audited; SMS codes never for staff (phishable).
5. **Hierarchy reads (SCL-01):** a parent tenant (state, region) sees only what a data-sharing agreement grants, default de-identified counts; nothing flows up implicitly.

## 9. Decisions needed before layer 1 can close

- Q-02 (email provider) can wait: Mailpit covers invitations and break-glass alerts locally.
- Confirmation of items 1–5 above, or changes.
