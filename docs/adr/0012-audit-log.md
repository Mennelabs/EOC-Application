# ADR-0012: Append-only, hash-chained audit log in Postgres with object-locked anchors

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-18, FR-00.03, FR-08.*, RULE-07, RULE-15, ADM-05

## Decision

`audit_event` in the platform database. The application role can only `INSERT` and `SELECT`; a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` for every role except the schema owner during migrations. Each row stores `hash = sha256(prev_hash ‖ canonical_json(row))` per tenant. A worker job verifies the chain and writes signed anchors (latest hash per tenant) to object storage with object lock every 15 minutes.

## Alternatives considered

| Option                                 | Why not                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Separate log service (e.g. OpenSearch) | Useful later for search, but not tamper-evident by itself; added as a copy, not the source of truth. |
| Cloud-native ledger (QLDB)             | Discontinued by AWS; cloud lock-in.                                                                  |
| Application logs only                  | Not attributable or tamper-evident.                                                                  |

## Why it fits SCL-11 and the government-cloud move

Pure Postgres plus the S3 API; S3 Object Lock is available in GovCloud.

## Consequences

Audit writes share the business transaction, so a failed business write never leaves an orphan audit row, and a successful one always has its audit row.

## Amendment 2026-10-15: audit rows are written last

Each tenant's chain is extended under a transaction-scoped advisory lock (migration 0040), held until commit. A transaction that wrote its audit row and then locked another row could deadlock with one that had locked that row and was waiting to audit; CI run 38698603482 lost a role approval that way, against the worker's `account.invited` job. Inside `withTenant` (every API request and every worker job), `recordAudit` now queues the row and writes it after the transaction's own work, just before commit (`beforeCommit` in `@cg/db`), in the order recorded. Every transaction therefore takes its row locks before the chain lock, and the chain lock is held only for the commit. A transaction opened any other way writes the row at once. The audit rows are still in the business transaction: a failed write leaves none. Tests: `services/api/test/auditchain.db.test.ts`, `permission-changes.db.test.ts`.
