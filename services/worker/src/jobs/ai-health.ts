/**
 * AI feature health on the worker's clock (layer-7 task A; AIG-09 as decided
 * 2026-10-15, AI-10, AIG-01). For every tenant, feature and language the job
 * looks at the latest outputs:
 *
 * - corrections: of the last outputs a person acted on, the share they edited
 *   or rejected;
 * - failures: of the last calls, the share that timed out, failed, was refused
 *   or came back unusable;
 * - complaints: of the last outputs, the share a resident said went wrong
 *   (AIG-09; a fixed reason, no words; default line 10%).
 *
 * Past the tenant's threshold (default: more than 30% of the last 50, once at
 * least 20 count) an alert is raised, the administrators who manage the AI use
 * register are told once by email, and the raise is audited. The feature keeps
 * running: Adam decided on alerts instead of AIG-09's automatic switch-off. An
 * alert clears, audited, when the share falls back under the threshold.
 *
 * Fairness (PHO-13 as decided 2026-10-15): for the severity suggestion, a
 * hazard, home type or income band whose reviewers agree with it more than the
 * margin below the model's overall agreement (default 10 points, once the
 * group has 20 decisions; tenant `ai.fairness`) raises a `fairness` alert
 * named `dimension:group`, told and audited the same way, cleared when the
 * group catches up.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import {
  AGREEMENT_DEFAULTS,
  agreementByModel,
  loadSeverityAgreement,
  type AgreementSettings,
} from '@cg/reporting';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import { staffRecipients } from './recipients.ts';
import { claimReminder, sendReminder } from './reminders.ts';
import type { JobContext } from './types.ts';

export interface AiHealthSettings {
  window: number;
  minimum: number;
  correctionRate: number;
  failureRate: number;
  complaintRate: number;
}

export const AI_HEALTH_DEFAULTS: AiHealthSettings = {
  window: 50,
  minimum: 20,
  correctionRate: 0.3,
  failureRate: 0.3,
  complaintRate: 0.1,
};

const FAILED = ['timeout', 'error', 'refused', 'invalid'];

type Kind = 'corrections' | 'failures' | 'complaints';

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
          .select(['outcome', 'human_action', 'complained_at'])
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
        {
          kind: 'complaints',
          counted: calls.length,
          flagged: calls.filter((r) => r.complained_at !== null).length,
          threshold: s.complaintRate,
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
                  : m.kind === 'complaints'
                    ? `residents said ${pct} of its last ${m.counted} outputs${lang} went wrong (the threshold is ${Math.round(m.threshold * 100)}%).`
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
    const fairness = await evaluateFairness(ctx, trx, tenantId);
    return { raised: [...raised, ...fairness.raised], cleared: [...cleared, ...fairness.cleared] };
  });
}

/** PHO-13: groups behind on agreement with the severity suggestion, raised and cleared. */
async function evaluateFairness(
  ctx: JobContext,
  trx: Transaction<Database>,
  tenantId: string,
): Promise<{ raised: string[]; cleared: string[] }> {
  const cfg = await trx
    .selectFrom('cg.tenant_config')
    .select('value')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', 'ai.fairness')
    .executeTakeFirst();
  const s: AgreementSettings = {
    ...AGREEMENT_DEFAULTS,
    ...((cfg?.value ?? {}) as Partial<AgreementSettings>),
  };
  const models = agreementByModel(await loadSeverityAgreement(trx, tenantId), s);
  const behind = new Map<
    string,
    { model: string; overall: number; decisions: number; agreed: number; rate: number }
  >();
  for (const m of models)
    for (const sl of m.slices)
      if (sl.behind)
        behind.set(`${sl.dimension}:${sl.group}`, {
          model: m.model,
          overall: m.rate,
          decisions: sl.decisions,
          agreed: sl.agreed,
          rate: sl.rate,
        });
  const open = await trx
    .selectFrom('cg.ai_health_alert')
    .select(['id', 'language'])
    .where('tenant_id', '=', tenantId)
    .where('feature', '=', 'photo.severity')
    .where('kind', '=', 'fairness')
    .where('cleared_at', 'is', null)
    .execute();
  const raised: string[] = [];
  const cleared: string[] = [];
  for (const [key, b] of behind) {
    if (open.some((o) => o.language === key)) continue;
    const alert = await trx
      .insertInto('cg.ai_health_alert')
      .values({
        tenant_id: tenantId,
        feature: 'photo.severity',
        language: key,
        kind: 'fairness',
        window_size: b.decisions,
        counted: b.decisions,
        flagged: b.decisions - b.agreed,
        rate: (1 - b.rate).toFixed(4),
        threshold: Math.min(1, 1 - (b.overall - s.margin)).toFixed(4),
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
      const [dimension, group] = key.split(':');
      await sendReminder(ctx, trx, tenantId, notice, emails, 'ai_quality_notice', {
        title: 'photo.severity',
        what: `reviewers agreed with its suggestion on ${Math.round(b.rate * 100)}% of ${b.decisions} decisions for ${dimension?.replace('_', ' ')} ${group}, against ${Math.round(b.overall * 100)}% overall (${b.model}); the margin is ${Math.round(s.margin * 100)} points (PHO-13).`,
      });
    }
    await systemAudit(trx, tenantId, 'ai-health', {
      action: 'ai.health_alert_raised',
      targetType: 'ai_health_alert',
      targetId: alert.id,
      changes: {
        fields: [
          { name: 'feature', to: 'photo.severity' },
          { name: 'kind', to: 'fairness' },
          { name: 'group', to: key },
          { name: 'rate', to: Number(b.rate.toFixed(4)) },
        ],
      },
    });
  }
  for (const o of open) {
    if (behind.has(o.language)) continue;
    await trx
      .updateTable('cg.ai_health_alert')
      .set({ cleared_at: new Date() })
      .where('id', '=', o.id)
      .execute();
    cleared.push(o.id);
    await systemAudit(trx, tenantId, 'ai-health', {
      action: 'ai.health_alert_cleared',
      targetType: 'ai_health_alert',
      targetId: o.id,
      changes: { fields: [{ name: 'group', to: o.language }] },
    });
  }
  return { raised, cleared };
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
