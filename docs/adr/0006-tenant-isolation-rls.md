# ADR-0006: Tenant isolation with Postgres row-level security plus per-tenant storage keys

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-05, SCL-01, ADM-05

## Decision
Shared database, shared schema, `tenant_id` on every tenant-owned row, enforced by RLS policies that read `current_setting('app.tenant_id')`. The application role is never the table owner and RLS is `FORCE`d. Object storage uses per-tenant prefixes and per-tenant data keys. Cross-tenant access (state views, partner sharing) happens only through data-sharing-agreement checks in the policy engine and dedicated, audited queries.

## Alternatives considered
| Option | Why not |
| --- | --- |
| Database per tenant | Strongest isolation, but thousands of jurisdictions × migrations × connections is costly; coalitions need cross-tenant aggregates. Kept as an option for very large tenants. |
| Schema per tenant | Same migration cost; RLS gives equal isolation with less operational load. |
| App-only filtering | One missed `WHERE` leaks data; SEC-05 requires enforcement in the database. |

## Why it fits SCL-11 and the government-cloud move
RLS is a core Postgres feature available in every managed offering.

## Consequences
An automated suite proves no cross-tenant read for every table and endpoint (SEC-05 acceptance). Connection pooling must use transaction mode with `SET LOCAL` only.
