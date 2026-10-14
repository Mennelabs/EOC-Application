/**
 * Migration drill for the enclave database: migrate to latest, report
 * dictionary coverage (SEC-11) and forced row security on every table that
 * carries an agency (SEC-12), then run the newest N migrations down and up
 * again to prove they are reversible. Exits non-zero on any finding.
 *
 *   CJIS_DATABASE_MIGRATOR_URL=postgres://cjis_migrator:...@127.0.0.1:5433/cjis \
 *   node packages/cjis-db/src/migrate-check.ts [steps-down=1]
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { migrations } from './migrations/index.ts';
import { dictionary } from './dictionary.ts';

const url = process.env['CJIS_DATABASE_MIGRATOR_URL'];
if (!url) {
  console.error('CJIS_DATABASE_MIGRATOR_URL is not set');
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

async function findings() {
  const undocumented = await sql<{ table_name: string; column_name: string }>`
    select * from cjis.undocumented_columns()`.execute(db);
  const columns = await sql<{ table_name: string; column_name: string }>`
    select table_name::text, column_name::text from information_schema.columns
    where table_schema = 'cjis'`.execute(db);
  const present = new Set(columns.rows.map((c) => `${c.table_name}.${c.column_name}`));
  const stale = Object.entries(dictionary).flatMap(([t, cols]) =>
    Object.keys(cols)
      .filter((c) => !present.has(`${t}.${c}`))
      .map((c) => `${t}.${c}`),
  );
  const noRls = await sql<{ t: string }>`
    select c.relname as t from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'cjis' and c.relkind in ('r', 'p') and not c.relforcerowsecurity
      and exists (select 1 from information_schema.columns col
                  where col.table_schema = 'cjis' and col.table_name = c.relname
                    and col.column_name = 'agency_id')`.execute(db);
  return {
    undocumented: undocumented.rows.map((r) => `${r.table_name}.${r.column_name}`),
    staleDictionary: stale,
    tablesWithoutRls: noRls.rows.map((r) => r.t),
  };
}

show('up', await migrator.migrateToLatest());
const first = await findings();
console.log(JSON.stringify(first));
for (let i = 0; i < steps; i++) show(`down ${i + 1}`, await migrator.migrateDown());
show('up again', await migrator.migrateToLatest());
const second = await findings();
await db.destroy();
const bad = [first, second].some(
  (f) => f.undocumented.length + f.staleDictionary.length + f.tablesWithoutRls.length > 0,
);
if (bad) {
  console.error('enclave migration drill found problems (SEC-11, SEC-12)');
  process.exit(1);
}
console.log(JSON.stringify({ msg: 'enclave migration drill passed', stepsDown: steps }));
