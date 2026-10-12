/**
 * System-role database helpers. The worker connects as cg_worker, which
 * passes every RLS policy (ADR-0006); `app.tenant_id` is still set per job so
 * inserts land in the right tenant and audit rows are attributed to it.
 */
import type { Kysely, Transaction } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import { recordAudit, type AuditInput } from '@cg/audit';

export async function asSystem<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return withTenant(db, { tenantId }, fn);
}

export function systemAudit(
  trx: Transaction<Database>,
  tenantId: string,
  job: string,
  input: Omit<AuditInput, 'tenantId' | 'actorKind' | 'actorAccountId'>,
) {
  return recordAudit(trx, {
    ...input,
    tenantId,
    actorKind: 'system',
    actorAccountId: null,
    reason: input.reason ?? `job:${job}`,
  });
}

/** Every tenant id, for schedules that iterate (system role sees all). */
export async function allTenantIds(db: Kysely<Database>): Promise<string[]> {
  const rows = await db
    .selectFrom('cg.tenant')
    .select('id')
    .where('status', '<>', 'closed')
    .execute();
  return rows.map((r) => r.id);
}
