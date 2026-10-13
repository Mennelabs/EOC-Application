/**
 * 0018 reviewer flags and duplicate keys (PHO-15, SEC-17, BRD:FR-12.04): when
 * the worker files a submission it records what a reviewer must see (possible
 * duplicate by answers, address or photo bytes; verification suggested by the
 * abuse score; AI-assisted answers) as flags on the report, never as a
 * decision. The hashes it compares are kept with the rows. Every column is in
 * the data dictionary in this migration (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.report add column flags jsonb not null default '[]'::jsonb`.execute(db);
  await sql`alter table cg.report add column content_hash bytea`.execute(db);
  await sql`create index report_content_hash_idx on cg.report (tenant_id, content_hash) where content_hash is not null`.execute(
    db,
  );
  await sql`alter table cg.location add column address_key text`.execute(db);
  await sql`create index location_address_key_idx on cg.location (tenant_id, address_key) where address_key is not null`.execute(
    db,
  );
  await sql`create index photo_sha256_idx on cg.photo (tenant_id, sha256) where sha256 is not null`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists cg.photo_sha256_idx`.execute(db);
  await sql`drop index if exists cg.location_address_key_idx`.execute(db);
  await sql`alter table cg.location drop column if exists address_key`.execute(db);
  await sql`drop index if exists cg.report_content_hash_idx`.execute(db);
  await sql`alter table cg.report drop column if exists content_hash`.execute(db);
  await sql`alter table cg.report drop column if exists flags`.execute(db);
}
