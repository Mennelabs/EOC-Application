/**
 * Migration drill for development: migrate to latest, report dictionary
 * coverage (SEC-11) and row-level security on every table (SEC-05), then run
 * the newest N migrations down and up again to prove they are reversible.
 *
 *   DATABASE_MIGRATOR_URL=postgres://cg_migrator:...@127.0.0.1:5432/cg \
 *   node packages/db/src/migrate-check.ts [steps-down=1]
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { migrations } from './migrations/index.ts';

const url = process.env['DATABASE_MIGRATOR_URL'];
if (!url) {
  console.error('DATABASE_MIGRATOR_URL is not set');
  process.exit(2);
}
const steps = Number(process.argv[2] ?? '1');

const db = new Kysely<unknown>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }),
});
const migrator = new Migrator({
  db,
  migrationTableSchema: 'public',
  provider: { getMigrations: async () => migrations },
});

function show(
  label: string,
  r: { error?: unknown; results?: { migrationName: string; status: string }[] },
): void {
  console.log(
    JSON.stringify({
      step: label,
      results: (r.results ?? []).map((x) => `${x.migrationName}:${x.status}`),
    }),
  );
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
}

show('up', await migrator.migrateToLatest());
const tables = await sql<{ n: string }>`
  select count(*)::text as n from information_schema.tables
  where table_schema = 'cg' and table_type = 'BASE TABLE'`.execute(db);
const dict = await sql<{ n: string }>`select count(*)::text as n from cg.data_dictionary`.execute(
  db,
);
const undocumented = await sql<{ table_name: string; column_name: string }>`
  select * from cg.undocumented_columns()`.execute(db);
// Every table that carries tenant data (a tenant_id column) must have RLS forced (SEC-05).
const noRls = await sql<{ t: string }>`
  select c.relname as t from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'cg' and c.relkind = 'r' and not c.relforcerowsecurity
    and exists (select 1 from information_schema.columns col
                where col.table_schema = 'cg' and col.table_name = c.relname and col.column_name = 'tenant_id')`.execute(
  db,
);
console.log(
  JSON.stringify({
    tables: Number(tables.rows[0]?.n),
    dictionaryRows: Number(dict.rows[0]?.n),
    undocumented: undocumented.rows.map((r) => `${r.table_name}.${r.column_name}`),
    tablesWithoutRls: noRls.rows.map((r) => r.t),
  }),
);
if (undocumented.rows.length > 0 || noRls.rows.length > 0) process.exit(1);
for (let i = 0; i < steps; i++) show(`down ${i + 1}`, await migrator.migrateDown());
show('up again', await migrator.migrateToLatest());
await db.destroy();
