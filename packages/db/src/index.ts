import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type { Database } from './schema.ts';
export * from './schema.ts';
export { dictionary, redactedColumnNames, restrictedColumns } from './dictionary.ts';
export type { Classification } from './dictionary.ts';
export { migrations } from './migrations/index.ts';
export * from './reference-codes.ts';
export * from './after-answers.ts';
export * from './health-notices.ts';

export function createDb(connectionString: string, max = 10): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max, application_name: 'common-ground' }),
    }),
  });
}

/**
 * Row-level-security context for one transaction (ADR-0006). Every request
 * and job runs its queries inside `withTenant`; the settings vanish when the
 * transaction ends, so pooled connections never leak a tenant.
 */
export interface TenantContext {
  tenantId: string;
  /** Own tenant plus tenants whose signed agreements grant read access. */
  visibleTenantIds?: readonly string[];
  tenantPath?: string;
  accountId?: string | null;
}

/** Work queued to run after a transaction's own work and before it commits. */
const beforeCommitQueues = new WeakMap<Transaction<Database>, (() => Promise<void>)[]>();

/**
 * Queues `work` to run once the transaction's own work is done, just before
 * it commits, in the order queued. A transaction opened by `withTenant` has
 * the queue; for any other transaction this returns false and the caller
 * does the work now. The audit writer uses it so that a transaction takes
 * every row lock before the tenant's audit chain lock (BRD:FR-08.04,
 * migration 0040): two transactions that lock rows and the chain in
 * opposite orders deadlock.
 */
export function beforeCommit(trx: Transaction<Database>, work: () => Promise<void>): boolean {
  const queue = beforeCommitQueues.get(trx);
  if (!queue) return false;
  queue.push(work);
  return true;
}

export async function withTenant<T>(
  db: Kysely<Database>,
  ctx: TenantContext,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`.execute(trx);
    await sql`select set_config('app.tenant_ids', ${[ctx.tenantId, ...(ctx.visibleTenantIds ?? [])].join(',')}, true)`.execute(
      trx,
    );
    await sql`select set_config('app.tenant_path', ${ctx.tenantPath ?? ''}, true)`.execute(trx);
    await sql`select set_config('app.account_id', ${ctx.accountId ?? ''}, true)`.execute(trx);
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
