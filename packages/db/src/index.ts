import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type { Database } from './schema.ts';
export * from './schema.ts';
export { dictionary, redactedColumnNames, restrictedColumns } from './dictionary.ts';
export { migrations } from './migrations/index.ts';

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
    return fn(trx);
  });
}
