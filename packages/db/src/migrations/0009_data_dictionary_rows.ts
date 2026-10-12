/**
 * 0009 data dictionary rows (SEC-11): loads packages/db/src/dictionary.ts into
 * cg.data_dictionary and refuses to finish if any column in schema cg is not
 * classified. Later migrations that add columns must extend dictionary.ts and
 * re-run this load (see 0010+ pattern: call cg.reload_data_dictionary()).
 */
import { sql, type Kysely } from 'kysely';
import { dictionary } from '../dictionary.ts';

/**
 * Loads the dictionary for the tables that exist at this point of the
 * migration chain: a fresh database runs 0009 before the layer-2 tables
 * exist, so entries for later tables wait for the migration that creates
 * them and reloads; the same goes for columns added to existing tables. One
 * check holds at every call: no existing column is undocumented. The drill
 * (migrate-check.ts) refuses entries that the final schema does not have
 * (a typo or a dropped column).
 */
export async function loadDictionary(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ table_name: string; column_name: string }>`
    select c.table_name::text, c.column_name::text
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'cg' and t.table_type = 'BASE TABLE'`.execute(db);
  const columns = new Set(existing.rows.map((r) => `${r.table_name}.${r.column_name}`));
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
    // Columns a later migration adds (or tables it creates) are loaded by that migration's reload.
    if (!columns.has(`${r.table}.${r.column}`)) continue;
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
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from cg.data_dictionary`.execute(db);
}
