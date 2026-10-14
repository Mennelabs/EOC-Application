/**
 * Enclave database access (SEC-12, ADR-0037). Kysely over the enclave's own
 * PostgreSQL; every request and job runs inside `withAgency`, which sets the
 * row-security context for one transaction only, so a pooled connection
 * never carries an agency into the next request.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { CjisDatabase } from './schema.ts';

export type { CjisDatabase } from './schema.ts';
export * from './schema.ts';
export { dictionary, encryptedColumns, redactedColumnNames, loadDictionary } from './dictionary.ts';
export { migrations } from './migrations/index.ts';

export function createCjisDb(connectionString: string, max = 10): Kysely<CjisDatabase> {
  return new Kysely<CjisDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max, application_name: 'cjis-enclave' }),
    }),
  });
}

export interface AgencyContext {
  agencyId: string;
  personId?: string | null;
}

export async function withAgency<T>(
  db: Kysely<CjisDatabase>,
  ctx: AgencyContext,
  fn: (trx: Transaction<CjisDatabase>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.agency_id', ${ctx.agencyId}, true)`.execute(trx);
    await sql`select set_config('app.person_id', ${ctx.personId ?? ''}, true)`.execute(trx);
    return fn(trx);
  });
}
