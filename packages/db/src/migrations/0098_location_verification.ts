/**
 * 0098 a location's cross streets and when it was verified (BRD:FR-03.01).
 * Cross streets were folded into the landmark text; they are a field of
 * their own now. A location saved as verified records when and by whom, so
 * dispatch can tell a fresh check from an old one.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.location
    add column cross_streets text,
    add column verified_at timestamptz,
    add column verified_by uuid`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.location
    drop column if exists verified_by,
    drop column if exists verified_at,
    drop column if exists cross_streets`.execute(db);
  await loadDictionary(db);
}
