/**
 * 0001 foundation: schema and least-privilege grants that every later
 * migration builds on. Extensions are created by the database init script
 * (infra/postgres/init) because PostGIS needs a superuser.
 *
 * - cg_migrator owns the schema; cg_app gets DML only, never DDL (ADR-0005).
 * - Default privileges let later migrations add tables cg_app can use; the
 *   audit migration in layer 1 revokes UPDATE/DELETE on audit tables (FR-08.04).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const ext of ['postgis', 'pgcrypto', 'ltree', 'citext']) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_extension where extname = ${ext}`.execute(db);
    if (rows[0]?.n !== 1) throw new Error(`required extension missing: ${ext}`);
  }
  await sql`create schema if not exists cg`.execute(db);
  await sql`revoke all on schema cg from public`.execute(db);
  await sql`grant usage on schema cg to cg_app`.execute(db);
  await sql`alter default privileges in schema cg
            grant select, insert, update, delete on tables to cg_app`.execute(db);
  await sql`alter default privileges in schema cg
            grant usage, select on sequences to cg_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop schema if exists cg cascade`.execute(db);
}
