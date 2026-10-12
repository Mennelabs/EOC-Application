# Layer 1 report: platform foundations

Date: 2026-10-12 (CI and Windows start-up fixes added the same day). Branch `claude/determined-gates-zd5i8m`, PR #1. Status record: [`layer-1-status.md`](layer-1-status.md). Evidence per requirement: [`../traceability.md`](../traceability.md).

## What was built

| Area                                                                                                                                                                                                                                   | Where                                                                                           | Requirements                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Tenancy hierarchy, events, licences, data-sharing agreements, versioned tenant configuration                                                                                                                                           | migrations 0002–0003, `routes/tenants.ts`, `routes/events.ts`                                   | SCL-01, SCL-02, SCL-07, SCL-10                   |
| Staff identity: one Keycloak realm per tenant, password-then-passkey browser flow, `cg_tenant_id` claim, invitations by email, accounts separate from personnel                                                                        | `services/worker/src/idp/keycloak.ts`, `services/api/src/auth/subject.ts`, `routes/accounts.ts` | SEC-07, BRD:FR-01.*, ACCT-01, BRD:INT-01         |
| Authorization: policy engine with seven guardrails no county can turn off, county-editable versioned roles, shipped templates from the WESTWIND cast and frontline roles, engine-backed preview, second-administrator change requests  | `packages/authz`, `routes/roles.ts`                                                             | BRD:FR-00.01/02, SEC-06, ADM-04, ADM-05, RULE-14 |
| Tenant isolation in the database: row-level security forced on every tenant table, a separate `cg_worker` role for system jobs                                                                                                         | migration 0002, ADR-0006                                                                        | SEC-05, BRD:FR-18.06                             |
| Audit: append-only, hash-chained per tenant, immutable even to the superuser, verifier, anchors to object storage, every read of restricted data recorded                                                                              | migration 0006, `packages/audit`, worker schedule                                               | SEC-18, BRD:FR-00.03, FR-08.*, RULE-07           |
| Save semantics: idempotent creates, optimistic versions, one error envelope, confirmation with reason for consequential actions                                                                                                        | `services/api/src/plugins/*`, `errors.ts`                                                       | BRD:FR-00.04–00.07, AC-00A–D                     |
| Data protection: a classification for all 308 columns enforced at migration time, AES-256-GCM field encryption with per-tenant keys in OpenBao (KMS later), blind-index lookup, retention defaults with legal holds and a deletion log | `packages/db/src/dictionary.ts`, `packages/crypto`, migration 0007, `routes/definitions.ts`     | SEC-10, SEC-11, SEC-13                           |
| Break-glass: time-boxed, justified, read-only, security contact notified, permission changes frozen                                                                                                                                    | `routes/breakglass.ts`, worker handler                                                          | SEC-08                                           |
| Worker: outbox relay and consumer, tenant provisioning, identity sync, break-glass notices, audit anchoring, break-glass expiry, retention housekeeping                                                                                | `services/worker`                                                                               | ADR-0007, ADR-0012                               |
| Console: tenant-realm sign-in with PKCE, administration workspaces, confirmation dialog, audit viewer with chain status                                                                                                                | `apps/web-console`                                                                              | CON-01, ADM-01                                   |
| Synthetic WESTWIND county: nine tenants, template roles, the console cast with role assignments; loaded by `seed-load`                                                                                                                 | `tools/seed`                                                                                    | SCL-12                                           |
| Backup, restore, drills                                                                                                                                                                                                                | `scripts/backup.sh`, `scripts/restore.sh`, `tests/drills/`                                      | NFR-05, GATE-09 (recovery half)                  |

## What passed

- **Checks:** typecheck, lint, ADM-03 product-name check; 79 unit tests (guardrails one file each, engine, templates and preview, audit redaction, field crypto, API plugins, seed); 21 integration tests against the running stack; 15 end-to-end tests on desktop and phone viewports with axe WCAG 2.2 AA on every released screen.
- **End to end, on clean volumes:** `docker compose up` provisions nine tenants (realms, template roles, retention defaults) through the outbox; a Keycloak token resolves to an account and its roles from the database; default deny with audited denials; the state liaison sees the hierarchy and none of the county's records; idempotent replay and 422 on key reuse; 409 with the current record on a stale version; second administrator required to approve and apply an assignment; break-glass needs confirmation, notifies the security contact (seen in Mailpit), freezes permission changes, ends; encrypted contact details shown only to roles with the category, found by blind index, every read audited.
- **Onboarding journey in a real browser:** API invite → invitation email → password → passkey registered on a virtual authenticator → console sign-in with password and passkey → home shows the role a second administrator approved → denied workspace shows the denial.
- **Drills:** restore (schema destroyed, restored from backup, audit heads identical, every chain verifies, immutability trigger present); audit tamper (application roles and superuser refused; a change made with the trigger disabled is detected with its sequence number).
- **Gates:** GATE-01 (public roles and permission boundaries documented in templates and the index), GATE-02 (acceptance cases above), GATE-04 (no known bypass), GATE-05 (idempotency, concurrency, consistency).

## What did not pass, or is not yet proven

Nothing is red. These are the honest gaps:

1. **Manual accessibility passes (GATE-03).** Automated axe checks pass on every released screen; the manual checklist (keyboard, NVDA/VoiceOver, 200% zoom) has no records yet. GATE-03 is claimed only for automated evidence.
2. **CI on GitHub.** Every run up to `cb80066` was red. The compose stack itself came up healthy on GitHub (run 13), but `docker compose up --wait` then failed on the finished `seed` one-shot (docker/compose#10596: a one-shot needs a dependant), Trivy flagged seven HIGH findings in the base image's bundled npm, Semgrep asked for an explicit GCM tag length and pnpm supply-chain settings, and prettier rejected the generated traceability table. All four are fixed (status task K); the integration and e2e steps run on GitHub for the first time after that push, so the first green run is still to be seen.
3. **MinIO image from source** (`infra/minio/Dockerfile`): built and healthy in CI run 13, so this is settled; only the build sandbox cannot build it (Docker Hub rate limit on `alpine`).
4. **SSO brokering (SEC-07).** Realms are ready to broker to a tenant's own SAML/OIDC provider; no test exercises an external provider yet.
5. **Partials by design** (see traceability): display in the tenant's timezone, record-category retention sweeps, OpenTelemetry metrics, infrastructure as code for the cloud. Each arrives with the layer that needs it.

## What was deferred and why

| What                                                                                     | Why                                                        | When              |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------- |
| Resident lookup by reference code + one-time code (SEC-09, RES-01)                       | needs reports                                              | layer 2           |
| Manual operational entries vs audit (BRD:FR-08.03), undo as compensating event (AC-08C)  | notes and undo arrive with missions and the command window | layers 4 and 7    |
| Geography as an authorization attribute (SEC-06)                                         | needs record geometries                                    | layer 2           |
| Migration half of GATE-09 (MIG-00–09)                                                    | no source system (finding C-04)                            | open, Q-05        |
| GovRAMP/SOC 2 evidence, multi-region availability, data residency (SEC-01/02/14, SCL-05) | only provable in the government cloud                      | `Gov` / `Process` |

## Decisions needed from you

1. **Approve layer 1 as done** on the evidence above, with gaps 1–5 recorded, so layer 2 (resident intake) can start.
2. **§8 defaults** used in layer 1 (second administrator, break-glass limits, 7-year audit floor, TOTP only by audited exception, hierarchy reads only through agreements): confirm or change.
3. **Open questions Q-01–Q-07** in `docs/decisions.md`: the defaults remain in force until you answer; Q-02 (email provider) and Q-05 (migration source) affect layer 2 earliest.
4. **Console UI dependency note:** native accessible elements first, React Aria when a complex widget needs it (ADR-0013 nuance). Say if you want React Aria from the start.
5. **Fan-out:** layer 2 can again run single-session, or the status file's ownership boundaries can be used for parallel sessions (intake web/SMS/IVR, review queue, photo pipeline). Your call.
