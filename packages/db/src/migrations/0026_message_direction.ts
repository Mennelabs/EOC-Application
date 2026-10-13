/**
 * 0026 inbound messages (layer-3 plan §5; FL-11, BRD:FR-17.04/17.05): a
 * resident's reply to a staff update lands on the report as a message, so
 * the board shows the whole exchange. One column says which way a message
 * went; outbound rows are untouched. Every column is in the dictionary.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.message add column direction text not null default 'outbound' check (direction in ('outbound', 'inbound'))`.execute(
    db,
  );
  await sql`create index message_report_created_idx on cg.message (report_id, created_at)`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists cg.message_report_created_idx`.execute(db);
  await sql`alter table cg.message drop column if exists direction`.execute(db);
}
