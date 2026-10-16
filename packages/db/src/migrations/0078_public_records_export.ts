/**
 * 0078 public-records releases (SEC-13). An export can now be a
 * `public_records` ZIP for one event: the records officer's request
 * reference, the period and the kinds of record asked for are kept in
 * `scope`; what may leave is decided column by column when the file is built
 * (packages/reporting public-records.ts). Down removes any such export rows.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.export_file add column scope jsonb`.execute(db);
  await sql`alter table cg.export_file drop constraint export_file_kind_check`.execute(db);
  await sql`alter table cg.export_file add constraint export_file_kind_check
    check (kind in ('ida_package', 'official_report', 'public_records'))`.execute(db);
  await sql`alter table cg.export_file add constraint export_file_public_records_check
    check (kind <> 'public_records' or (format = 'zip' and scope is not null))`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.export_file no force row level security`.execute(db);
  await sql`delete from cg.export_file where kind = 'public_records'`.execute(db);
  await sql`alter table cg.export_file force row level security`.execute(db);
  await sql`alter table cg.export_file drop constraint export_file_public_records_check`.execute(
    db,
  );
  await sql`alter table cg.export_file drop constraint export_file_kind_check`.execute(db);
  await sql`alter table cg.export_file add constraint export_file_kind_check
    check (kind in ('ida_package', 'official_report'))`.execute(db);
  await sql`alter table cg.export_file drop column if exists scope`.execute(db);
  await loadDictionary(db);
}
