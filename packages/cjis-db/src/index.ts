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

/** Reads the one account a verified token names, before its agency is known (migration 0005). */
export async function personBySubject(
  db: Kysely<CjisDatabase>,
  subject: string,
): Promise<{ id: string; agency_id: string } | undefined> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.subject', ${subject}, true)`.execute(trx);
    return trx
      .selectFrom('cjis.person')
      .select(['id', 'agency_id'])
      .where('idp_subject', '=', subject)
      .executeTakeFirst();
  });
}

/** Work queued to run after a transaction's own work and before it commits. */
const beforeCommitQueues = new WeakMap<Transaction<CjisDatabase>, (() => Promise<void>)[]>();

/**
 * Queues `work` to run once the transaction's own work is done, just before
 * it commits, in the order queued. A transaction opened by `withAgency` has
 * the queue; for any other this returns false and the caller does the work
 * now. The audit writer uses it so a transaction locks its rows before the
 * agency's audit chain (migration 0004): two transactions that take a row
 * and the chain in opposite orders deadlock (as the platform found, ADR-0012
 * amendment of 2026-10-15).
 */
export function beforeCommit(trx: Transaction<CjisDatabase>, work: () => Promise<void>): boolean {
  const queue = beforeCommitQueues.get(trx);
  if (!queue) return false;
  queue.push(work);
  return true;
}

export async function withAgency<T>(
  db: Kysely<CjisDatabase>,
  ctx: AgencyContext,
  fn: (trx: Transaction<CjisDatabase>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.agency_id', ${ctx.agencyId}, true)`.execute(trx);
    await sql`select set_config('app.person_id', ${ctx.personId ?? ''}, true)`.execute(trx);
    const queue: (() => Promise<void>)[] = [];
    beforeCommitQueues.set(trx, queue);
    try {
      const result = await fn(trx);
      // Queued work may queue more; it all runs before the commit.
      for (let i = 0; i < queue.length; i++) await queue[i]!();
      return result;
    } finally {
      beforeCommitQueues.delete(trx);
    }
  });
}
