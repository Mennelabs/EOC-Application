/**
 * 0020 after-saving answers and confirmation texts (INT-19, INT-22, ACC-30):
 * the optional questions are answered after the report is safely saved, so
 * they arrive after the submission and may precede the worker's filing; the
 * submission row keeps them (encrypted) until they are merged into the
 * report. "Text this number to me" is counted per submission. Columns are
 * in the dictionary in this migration (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.intake_submission add column after_enc bytea`.execute(db);
  await sql`alter table cg.intake_submission add column after_merged_at timestamptz`.execute(db);
  await sql`alter table cg.intake_submission add column confirmation_texts integer not null default 0`.execute(
    db,
  );
  await sql`create index intake_submission_after_idx on cg.intake_submission (tenant_id) where after_enc is not null and after_merged_at is null`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists cg.intake_submission_after_idx`.execute(db);
  await sql`alter table cg.intake_submission drop column if exists confirmation_texts`.execute(db);
  await sql`alter table cg.intake_submission drop column if exists after_merged_at`.execute(db);
  await sql`alter table cg.intake_submission drop column if exists after_enc`.execute(db);
}
