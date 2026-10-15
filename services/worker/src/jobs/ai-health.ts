/**
 * AI feature health on the worker's clock (layer-7 task A; AIG-09 as decided
 * 2026-10-15, AI-10, AIG-01). For every tenant, feature and language the job
 * looks at the latest outputs:
 *
 * - corrections: of the last outputs a person acted on, the share they edited
 *   or rejected;
 * - failures: of the last calls, the share that timed out, failed, was refused
 *   or came back unusable.
 *
 * Past the tenant's threshold (default: more than 30% of the last 50, once at
 * least 20 count) an alert is raised, the administrators who manage the AI use
 * register are told once by email, and the raise is audited. The feature keeps
 * running: Adam decided on alerts instead of AIG-09's automatic switch-off. An
 * alert clears, audited, when the share falls back under the threshold.
 */
import { sql } from 'kysely';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import { staffRecipients } from './recipients.ts';
import { claimReminder, sendReminder } from './reminders.ts';
import type { JobContext } from './types.ts';

export interface AiHealthSettings {
  window: number;
  minimum: number;
  correctionRate: number;
  failureRate: number;
}

export const AI_HEALTH_DEFAULTS: AiHealthSettings = {
  window: 50,
  minimum: 20,
  correctionRate: 0.3,
  failureRate: 0.3,
};

const FAILED = ['timeout', 'error', 'refused', 'invalid'];

type Kind = 'corrections' | 'failures';

/** One tenant: the alerts that hold are raised (and told once), the rest cleared. */
export async function evaluateAiHealthFor(
  ctx: JobContext,
  tenantId: string,
): Promise<{ raised: string[]; cleared: string[] }> {
  return asSystem(ctx.db, tenantId, async (trx) => {
    const cfg = await trx
      .selectFrom('cg.tenant_config')
      .select('value')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', 'ai.health')
      .executeTakeFirst();
    const s: AiHealthSettings = {
      ...AI_HEALTH_DEFAULTS,
      ...((cfg?.value ?? {}) as Partial<AiHealthSettings>),
    };
    const groups = await trx
      .selectFrom('cg.ai_output')
      .select(['feature', sql<string>`coalesce(language, '')`.as('language')])
      .where('tenant_id', '=', tenantId)
      .where('created_at', '>', sql<Date>`now() - interval '90 days'`)
      .groupBy(['feature', sql`coalesce(language, '')`])
      .execute();
    const raised: string[] = [];
    const cleared: string[] = [];
    for (const g of groups) {
      const recent = (acted: boolean) =>
        trx
          .selectFrom('cg.ai_output')
          .select(['outcome', 'human_action'])
          .where('tenant_id', '=', tenantId)
          .where('feature', '=', g.feature)
          .where(sql<boolean>`coalesce(language, '') = ${g.language}`)
          .$if(acted, (q) => q.where('human_action', 'is not', null))
          .orderBy('created_at', 'desc')
          .limit(s.window)
          .execute();
      const corrections = await recent(true);
      const calls = await recent(false);
      const measures: { kind: Kind; counted: number; flagged: number; threshold: number }[] = [
        {
          kind: 'corrections',
          counted: corrections.length,
          flagged: corrections.filter((r) => r.human_action !== 'accepted').length,
          threshold: s.correctionRate,
        },
        {
          kind: 'failures',
          counted: calls.length,
          flagged: calls.filter((r) => FAILED.includes(r.outcome)).length,
          threshold: s.failureRate,
        },
      ];
      for (const m of measures) {
        if (m.counted < s.minimum) continue;
        const rate = m.flagged / m.counted;
        const open = await trx
          .selectFrom('cg.ai_health_alert')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('feature', '=', g.feature)
          .where('language', '=', g.language)
          .where('kind', '=', m.kind)
          .where('cleared_at', 'is', null)
          .executeTakeFirst();
        if (rate > m.threshold && !open) {
          const alert = await trx
            .insertInto('cg.ai_health_alert')
            .values({
              tenant_id: tenantId,
              feature: g.feature,
              language: g.language,
              kind: m.kind,
              window_size: s.window,
              counted: m.counted,
              flagged: m.flagged,
              rate: rate.toFixed(4),
              threshold: m.threshold.toFixed(4),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          raised.push(alert.id);
          const notice = await claimReminder(trx, tenantId, {
            kind: 'ai_health',
            subjectKind: 'ai_health_alert',
            subjectId: alert.id,
            cycleKey: 'raised',
            dueAt: new Date(),
          });
          if (notice) {
            const { emails } = await staffRecipients(trx, tenantId, ['ai_register.write'], {
              includeAdmins: true,
            });
            const pct = `${Math.round(rate * 100)}%`;
            const lang = g.language ? ` in ${g.language}` : '';
            await sendReminder(ctx, trx, tenantId, notice, emails, 'ai_quality_notice', {
              title: g.feature,
              what:
                m.kind === 'corrections'
                  ? `people edited or rejected ${pct} of its last ${m.counted} outputs${lang} (the threshold is ${Math.round(m.threshold * 100)}%).`
                  : `${pct} of its last ${m.counted} calls${lang} failed or timed out; people did the work by hand (the threshold is ${Math.round(m.threshold * 100)}%).`,
            });
          }
          await systemAudit(trx, tenantId, 'ai-health', {
            action: 'ai.health_alert_raised',
            targetType: 'ai_health_alert',
            targetId: alert.id,
            changes: {
              fields: [
                { name: 'feature', to: g.feature },
                { name: 'kind', to: m.kind },
                { name: 'rate', to: Number(rate.toFixed(4)) },
              ],
            },
          });
        } else if (rate <= m.threshold && open) {
          await trx
            .updateTable('cg.ai_health_alert')
            .set({ cleared_at: new Date() })
            .where('id', '=', open.id)
            .execute();
          cleared.push(open.id);
          await systemAudit(trx, tenantId, 'ai-health', {
            action: 'ai.health_alert_cleared',
            targetType: 'ai_health_alert',
            targetId: open.id,
            changes: { fields: [{ name: 'rate', to: Number(rate.toFixed(4)) }] },
          });
        }
      }
    }
    return { raised, cleared };
  });
}

/** Every tenant, on the schedule. */
export async function evaluateAiHealth(ctx: JobContext): Promise<void> {
  for (const tenantId of await allTenantIds(ctx.db)) {
    try {
      await evaluateAiHealthFor(ctx, tenantId);
    } catch (err) {
      ctx.log.warn({ err, tenantId }, 'AI health could not be evaluated');
    }
  }
}
