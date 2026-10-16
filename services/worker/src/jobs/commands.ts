/**
 * Command window housekeeping (layer-7 task C; CMD-36, CMD-37, SEC-13,
 * RULE-15, Section 30.2).
 *
 * - Personal command history older than the tenant's `command_conversation`
 *   retention (30 days by default) is deleted, logged in the deletion log and
 *   audited. A legal hold on the category, or on one person's history, keeps
 *   it (SEC-13: legal holds override deletion).
 * - A plan nobody confirmed within 15 minutes is marked stale and, like a plan
 *   that ran, keeps only the digest and length of the free text it carried;
 *   the text itself never sits in the execution record (CMD-37, NFR-10).
 * The execution records themselves follow the audit retention and are never
 * deleted here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

/** The catalog's free-text arguments (a unit test in services/api keeps this list complete). */
export const FREE_TEXT_ARGS = [
  'note',
  'text',
  'title',
  'reason',
  'person',
  'requestReference',
  'message',
  'summary',
] as const;

/** Section 30.2 and the API's plan lifetime: unconfirmed for this long, a plan is prepared again. */
export const PLAN_TTL_MS = 15 * 60_000;

const nowOf = (ctx: JobContext) => ctx.now?.() ?? new Date();

/** Free text becomes its digest and length; everything else in the plan stays. */
export function stripFreeText(plan: Record<string, unknown>): Record<string, unknown> {
  const args = { ...((plan['args'] as Record<string, unknown> | undefined) ?? {}) };
  for (const k of FREE_TEXT_ARGS) {
    const v = args[k];
    if (typeof v === 'string')
      args[k] = {
        digest: createHash('sha256').update(v).digest('hex').slice(0, 16),
        length: v.length,
      };
  }
  return { ...plan, args };
}

export async function staleAbandonedPlans(ctx: JobContext): Promise<number> {
  const cutoff = new Date(nowOf(ctx).getTime() - PLAN_TTL_MS);
  let total = 0;
  for (const tenantId of await allTenantIds(ctx.db)) {
    total += await asSystem(ctx.db, tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('cg.command_execution')
        .select(['id', 'plan'])
        .where('tenant_id', '=', tenantId)
        .where('state', '=', 'awaiting_confirmation')
        .where('created_at', '<', cutoff)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const r of rows)
        await trx
          .updateTable('cg.command_execution')
          .set({
            state: 'stale',
            plan: JSON.stringify(stripFreeText(r.plan as Record<string, unknown>)),
            result: JSON.stringify({
              httpStatus: 409,
              error: {
                code: 'plan_stale',
                message: 'Nobody confirmed this within 15 minutes. Prepare it again.',
              },
            }),
          })
          .where('id', '=', r.id)
          .where('state', '=', 'awaiting_confirmation')
          .execute();
      if (rows.length > 0)
        await systemAudit(trx, tenantId, 'command-plans', {
          action: 'command.expired',
          targetType: 'command_execution',
          targetId: `${rows.length} plans`,
        });
      return rows.length;
    });
  }
  return total;
}

export async function sweepCommandHistory(ctx: JobContext): Promise<number> {
  const executionId = randomUUID();
  const now = nowOf(ctx);
  let total = 0;
  for (const tenantId of await allTenantIds(ctx.db)) {
    total += await asSystem(ctx.db, tenantId, async (trx) => {
      const keep = await sql<{ days: string | null }>`
        select (extract(epoch from keep_for) / 86400)::text as days from cg.retention_policy
        where tenant_id = ${tenantId} and data_category = 'command_conversation'
          and keep_for is not null`.execute(trx);
      const days = Number(keep.rows[0]?.days ?? 30);
      if (!Number.isFinite(days) || days <= 0) return 0;
      const holds = await trx
        .selectFrom('cg.legal_hold')
        .select('scope')
        .where('tenant_id', '=', tenantId)
        .where('released_at', 'is', null)
        .execute();
      const heldAccounts: string[] = [];
      for (const h of holds) {
        const sc = (h.scope ?? {}) as Record<string, unknown>;
        if (sc['dataCategory'] === 'command_conversation') return 0;
        if (sc['targetType'] === 'command_message') {
          if (typeof sc['targetId'] !== 'string') return 0;
          heldAccounts.push(sc['targetId']);
        }
      }
      let q = trx
        .deleteFrom('cg.command_message')
        .where('tenant_id', '=', tenantId)
        .where('created_at', '<', new Date(now.getTime() - days * 86_400_000));
      const held = heldAccounts.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
      if (held.length > 0) q = q.where('account_id', 'not in', held);
      const gone = await q.returning('created_at').execute();
      if (gone.length === 0) return 0;
      const times = gone.map((g) => g.created_at.getTime());
      await trx
        .insertInto('cg.deletion_log')
        .values({
          tenant_id: tenantId,
          data_category: 'command_conversation',
          target_type: 'command_message',
          deleted_count: gone.length,
          oldest: new Date(Math.min(...times)),
          newest: new Date(Math.max(...times)),
          execution_id: executionId,
        })
        .execute();
      await systemAudit(trx, tenantId, 'retention.sweep', {
        action: 'retention.delete',
        targetType: 'command_message',
        targetId: `${gone.length} rows`,
        executionId,
      });
      return gone.length;
    });
  }
  return total;
}
