/**
 * Equity and coverage alerts on the worker's clock (layer-6 task G; EQ-12,
 * CON-07, EQ-13): for every active event, the equity figures are worked out
 * as the dashboard shows them and the flags that hold are recorded: a new
 * one raised, one that no longer holds cleared, an acknowledged one left as
 * it is. Each raise and clear is in the tenant's audit chain. Counts only.
 */
import { equityData, raiseEquityAlerts } from '@cg/reporting';
import { asSystem, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

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
      await asSystem(ctx.db, e.tenant_id, async (trx) => {
        const data = await equityData(trx, e.tenant_id, e.id, ctx.now?.() ?? new Date());
        if (!data) return;
        const { raised, cleared } = await raiseEquityAlerts(trx, e.tenant_id, e.id, data.alerts);
        for (const id of raised)
          await systemAudit(trx, e.tenant_id, 'equity', {
            action: 'equity.alert_raised',
            targetType: 'equity_alert',
            targetId: id,
            changes: { eventId: e.id },
          });
        for (const id of cleared)
          await systemAudit(trx, e.tenant_id, 'equity', {
            action: 'equity.alert_cleared',
            targetType: 'equity_alert',
            targetId: id,
            changes: { eventId: e.id },
          });
      });
    } catch (err) {
      ctx.log.warn({ err, eventId: e.id }, 'equity alerts could not be evaluated');
    }
  }
}
