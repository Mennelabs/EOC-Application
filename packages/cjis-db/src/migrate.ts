/**
 * Runs pending enclave migrations as the enclave schema owner
 * (CJIS_DATABASE_MIGRATOR_URL). Used by the one-shot `cjis-migrate` service.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { migrations } from './migrations/index.ts';

const url = process.env['CJIS_DATABASE_MIGRATOR_URL'];
if (!url) {
  console.error('CJIS_DATABASE_MIGRATOR_URL is not set');
  process.exit(2);
}

const db = new Kysely<unknown>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }),
});
const migrator = new Migrator({
  db,
  migrationTableSchema: 'public',
  provider: { getMigrations: async () => migrations },
});

for (let attempt = 1; ; attempt++) {
  try {
    await sql`select 1`.execute(db);
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const { error, results } = await migrator.migrateToLatest();
for (const r of results ?? []) {
  console.log(JSON.stringify({ msg: 'cjis migration', name: r.migrationName, status: r.status }));
}
await db.destroy();
if (error) {
  console.error(JSON.stringify({ msg: 'cjis migration failed', error: String(error) }));
  process.exit(1);
}
