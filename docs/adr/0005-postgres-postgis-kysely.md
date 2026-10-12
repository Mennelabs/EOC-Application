# ADR-0005: PostgreSQL 16 + PostGIS, Kysely query builder, SQL migrations

- Status: proposed
- Date: 2026-10-12
- Requirements: SCL-11, SEC-05, FR-00.05, FLD-04/05, DCL:DEC-05

## Decision

PostgreSQL 16 with PostGIS 3.4 as the system of record. Data access through Kysely (type-safe SQL builder) over `pg`. Migrations are ordered TypeScript files containing plain SQL, run by Kysely's migrator. Row-level security policies, grants and triggers live in the migrations.

## Alternatives considered

| Option                | Why not                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Prisma                | Weak support for RLS session variables, PostGIS types and hand-written SQL.                   |
| Drizzle               | Close second; Kysely's raw-SQL escape hatches and transaction control fit RLS better.         |
| TypeORM               | Active-record patterns hide queries; harder to audit.                                         |
| MongoDB / document DB | No RLS, weaker geospatial and transactional guarantees for assignment consistency (FR-06.02). |

## Why it fits SCL-11 and the government-cloud move

Amazon RDS / Aurora PostgreSQL and Azure Database for PostgreSQL both support PostGIS and RLS in their government regions. Only the connection string changes.

## Consequences

- Each request runs in a transaction that sets `app.tenant_id` and related settings with `SET LOCAL`; RLS policies read them (see ADR-0006).
- Two database roles: `cg_migrator` (owns schema) and `cg_app` (no DDL, no update/delete on audit).
