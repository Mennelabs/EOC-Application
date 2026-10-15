/**
 * Equity and coverage alerts on the worker's clock (layer-6 task G; EQ-12,
 * CON-07, EQ-13): for every active event, the equity figures are worked out
 * as the dashboard shows them and the flags that hold are recorded: a new
 * one raised, one that no longer holds cleared, an acknowledged one left as
 * it is. Each raise and clear is in the tenant's audit chain. Counts only.
 */
import { equityData, raiseEquityAlerts } from '@cg/reporting';
import { asSystem, systemAudit } from '../system.ts';
import type { JobContext, TopicHandler } from './types.ts';

/** One event: the flags that hold now are recorded, the rest cleared; each change audited. */
export async function evaluateEvent(
  ctx: JobContext,
  tenantId: string,
  eventId: string,
): Promise<{ raised: number; cleared: number }> {
  return asSystem(ctx.db, tenantId, async (trx) => {
    const data = await equityData(trx, tenantId, eventId, ctx.now?.() ?? new Date());
    if (!data) return { raised: 0, cleared: 0 };
    const { raised, cleared } = await raiseEquityAlerts(trx, tenantId, eventId, data.alerts);
    for (const id of raised)
      await systemAudit(trx, tenantId, 'equity', {
        action: 'equity.alert_raised',
        targetType: 'equity_alert',
        targetId: id,
        changes: { eventId },
      });
    for (const id of cleared)
      await systemAudit(trx, tenantId, 'equity', {
        action: 'equity.alert_cleared',
        targetType: 'equity_alert',
        targetId: id,
        changes: { eventId },
      });
    return { raised: raised.length, cleared: cleared.length };
  });
}

/** Every active event, on the schedule. */
export async function evaluateEquityAlerts(ctx: JobContext): Promise<void> {
  const events = await ctx.db
    .selectFrom('cg.event as e')
    .innerJoin('cg.tenant as t', 't.id', 'e.tenant_id')
    .select(['e.id', 'e.tenant_id'])
    .where('e.status', '=', 'active')
    .where('t.status', '<>', 'closed')
    .execute();
  for (const e of events) {
    try {
      await evaluateEvent(ctx, e.tenant_id, e.id);
    } catch (err) {
      ctx.log.warn({ err, eventId: e.id }, 'equity alerts could not be evaluated');
    }
  }
}

/** equity.evaluate: staff asked for a check now (the console's "Check now"). */
export const equityEvaluate: TopicHandler = async (ctx, msg) => {
  const eventId = msg.payload['eventId'];
  if (typeof eventId !== 'string') return;
  await evaluateEvent(ctx, msg.tenantId, eventId);
};
