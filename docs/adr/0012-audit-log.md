# ADR-0012: Append-only, hash-chained audit log in Postgres with object-locked anchors

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-18, FR-00.03, FR-08.*, RULE-07, RULE-15, ADM-05

## Decision
`audit_event` in the platform database. The application role can only `INSERT` and `SELECT`; a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` for every role except the schema owner during migrations. Each row stores `hash = sha256(prev_hash ‖ canonical_json(row))` per tenant. A worker job verifies the chain and writes signed anchors (latest hash per tenant) to object storage with object lock every 15 minutes.

## Alternatives considered
| Option | Why not |
| --- | --- |
| Separate log service (e.g. OpenSearch) | Useful later for search, but not tamper-evident by itself; added as a copy, not the source of truth. |
| Cloud-native ledger (QLDB) | Discontinued by AWS; cloud lock-in. |
| Application logs only | Not attributable or tamper-evident. |

## Why it fits SCL-11 and the government-cloud move
Pure Postgres plus the S3 API; S3 Object Lock is available in GovCloud.

## Consequences
Audit writes share the business transaction, so a failed business write never leaves an orphan audit row, and a successful one always has its audit row.
