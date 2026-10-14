/**
 * Enclave data dictionary (SEC-11, SEC-12): the classification of every
 * column in schema `cjis`. `cji` marks criminal-justice information, which
 * the enclave stores encrypted under the owning agency's key (SEC-10) and
 * never logs. Each migration that adds columns reloads this file; the load
 * fails on any column without an entry, and the drill (migrate-check.ts)
 * fails on any entry the final schema lacks.
 */
import { sql, type Kysely } from 'kysely';

export type Classification = 'public' | 'internal' | 'sensitive' | 'restricted' | 'cji';

export interface ColumnEntry {
  c: Classification;
  /** Retention category, default 'records' (SEC-13). */
  r?: string;
  d?: string;
}

const i: ColumnEntry = { c: 'internal' };
export const dictionary: Record<string, Record<string, ColumnEntry>> = {
  data_dictionary: {
    table_name: i,
    column_name: i,
    classification: i,
    retention_category: i,
    description: i,
  },
  agency: {
    id: i,
    name: { c: 'internal', d: 'Criminal-justice agency name' },
    agency_identifier: {
      c: 'internal',
      d: 'Agency identifier; exercise values only until the state CJIS audit (SCL-12)',
    },
    platform_county: { c: 'internal', d: 'Declared: the platform county this agency serves' },
    status: i,
    exercise: { c: 'internal', d: 'SCL-12: true for synthetic exercise agencies' },
    version: i,
    created_at: i,
    updated_at: i,
  },
};

/** Columns stored encrypted under the agency key (SEC-10). */
export function encryptedColumns(): { table: string; column: string }[] {
  return Object.entries(dictionary).flatMap(([t, cols]) =>
    Object.entries(cols)
      .filter(([name, e]) => (e.c === 'cji' || e.c === 'restricted') && name.endsWith('_enc'))
      .map(([column]) => ({ table: t, column })),
  );
}

/** Column names the enclave logger must never print. */
export function redactedColumnNames(): string[] {
  const names = new Set<string>();
  for (const cols of Object.values(dictionary)) {
    for (const [name, e] of Object.entries(cols)) {
      if (e.c !== 'public' && e.c !== 'internal') names.add(name);
    }
  }
  return [...names].sort();
}

/** Loads the entries for the columns that exist now and refuses any undocumented column. */
export async function loadDictionary(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ table_name: string; column_name: string }>`
    select c.table_name::text, c.column_name::text
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'cjis' and t.table_type = 'BASE TABLE'`.execute(db);
  const columns = new Set(existing.rows.map((r) => `${r.table_name}.${r.column_name}`));
  await sql`delete from cjis.data_dictionary`.execute(db);
  for (const [table, cols] of Object.entries(dictionary)) {
    for (const [column, e] of Object.entries(cols)) {
      if (!columns.has(`${table}.${column}`)) continue;
      await sql`
        insert into cjis.data_dictionary (table_name, column_name, classification, retention_category, description)
        values (${table}, ${column}, ${e.c}, ${e.r ?? 'records'}, ${e.d ?? null})`.execute(db);
    }
  }
  const missing = await sql<{ table_name: string; column_name: string }>`
    select * from cjis.undocumented_columns()`.execute(db);
  if (missing.rows.length > 0) {
    const list = missing.rows.map((m) => `${m.table_name}.${m.column_name}`).join(', ');
    throw new Error(`SEC-11: enclave columns without a data-dictionary entry: ${list}`);
  }
}
