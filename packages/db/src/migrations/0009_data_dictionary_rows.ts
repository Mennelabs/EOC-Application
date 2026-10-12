/**
 * 0009 data dictionary rows (SEC-11): loads packages/db/src/dictionary.ts into
 * cg.data_dictionary and refuses to finish if any column in schema cg is not
 * classified. Later migrations that add columns must extend dictionary.ts and
 * re-run this load (see 0010+ pattern: call cg.reload_data_dictionary()).
 */
import { sql, type Kysely } from 'kysely';
import { dictionary } from '../dictionary.ts';

export async function loadDictionary(db: Kysely<unknown>): Promise<void> {
  const rows = Object.entries(dictionary).flatMap(([table, cols]) =>
    Object.entries(cols).map(([column, e]) => ({
      table,
      column,
      classification: e.c,
      retention: e.r ?? 'records',
      description: e.d ?? null,
    })),
  );
  await sql`delete from cg.data_dictionary`.execute(db);
  for (const r of rows) {
    await sql`
      insert into cg.data_dictionary (table_name, column_name, classification, retention_category, description)
      values (${r.table}, ${r.column}, ${r.classification}, ${r.retention}, ${r.description})`.execute(
      db,
    );
  }
  const missing = await sql<{ table_name: string; column_name: string }>`
    select * from cg.undocumented_columns()`.execute(db);
  if (missing.rows.length > 0) {
    const list = missing.rows.map((m) => `${m.table_name}.${m.column_name}`).join(', ');
    throw new Error(`SEC-11: columns without a data-dictionary entry: ${list}`);
  }
  const stale = await sql<{ table_name: string; column_name: string }>`
    select d.table_name, d.column_name from cg.data_dictionary d
    where not exists (
      select 1 from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'cg' and t.table_type = 'BASE TABLE'
        and c.table_name = d.table_name and c.column_name = d.column_name)`.execute(db);
  if (stale.rows.length > 0) {
    const list = stale.rows.map((m) => `${m.table_name}.${m.column_name}`).join(', ');
    throw new Error(`data dictionary names columns that do not exist: ${list}`);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from cg.data_dictionary`.execute(db);
}
