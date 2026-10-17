/**
 * The damage severity suggestion (layer-7 task I; PHO-09, PHO-10, PHO-12 as
 * decided 2026-10-15, AI-10, AIG-01). After a report's photo is processed, the
 * provider's classifier looks at the report's blurred review copies with its
 * home type and hazard (only photos the sensitive-region detector cleared), and
 * suggests a FEMA degree or "cannot tell", with a
 * confidence and the features it rests on. It runs only where the register has
 * `photo.severity` on for the provider in force; the call is made outside any
 * transaction and recorded whatever its outcome. The suggestion is kept for
 * reviewers only; nobody's degree changes, and a resident never sees it. The
 * same set of photos is not looked at twice.
 */
import { callAi, recordAiOutput } from '@cg/ai';
import { asSystem, systemAudit } from '../system.ts';
import type { TopicHandler } from './types.ts';

/** The classifier looks at no more than this many photos (the provider takes four). */
const MAX_PHOTOS = 4;

export const reportSeverity: TopicHandler = async (ctx, msg) => {
  const reportId = String(msg.payload['reportId'] ?? '');
  const tenantId = msg.tenantId;
  const prep = await asSystem(ctx.db, tenantId, async (trx) => {
    const feature = await trx
      .selectFrom('cg.ai_use_register')
      .select(['enabled', 'provider'])
      .where('tenant_id', '=', tenantId)
      .where('feature', '=', 'photo.severity')
      .executeTakeFirst();
    if (!feature?.enabled) return null;
    const provider = await ctx.ai.providerFor(tenantId, trx);
    if (!provider?.classifier || provider.info.provider !== feature.provider) return null;
    const report = await trx
      .selectFrom('cg.report as r')
      .leftJoin('cg.event as e', 'e.id', 'r.event_id')
      .select(['r.id', 'r.answers', 'r.withdrawn_at', 'e.hazard_type'])
      .where('r.id', '=', reportId)
      .executeTakeFirst();
    if (!report || report.withdrawn_at) return null;
    // Only photos the detector cleared: their review copy is blurred where it found faces,
    // plates, documents or house numbers (PHO-07, AIG-05). A photo whose detection was off or
    // failed keeps an unblurred review copy and is never sent.
    const photos = await trx
      .selectFrom('cg.photo')
      .select(['id', 'derivative_keys'])
      .where('report_id', '=', reportId)
      .where('status', '=', 'processed')
      .where('blur_status', '=', 'applied')
      .orderBy('created_at')
      .limit(MAX_PHOTOS)
      .execute();
    if (!photos.length) return null;
    const ids = photos.map((p) => p.id).sort();
    const last = await trx
      .selectFrom('cg.damage_suggestion')
      .select('photo_ids')
      .where('report_id', '=', reportId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (last && [...last.photo_ids].sort().join() === ids.join()) return null;
    const answers = (report.answers ?? {}) as Record<string, unknown>;
    return {
      provider,
      photos,
      ids,
      context: {
        ...(typeof answers['home_type'] === 'string' ? { homeType: answers['home_type'] } : {}),
        ...(report.hazard_type
          ? { hazard: report.hazard_type }
          : typeof answers['cause'] === 'string'
            ? { hazard: answers['cause'] }
            : {}),
      },
    };
  });
  if (!prep) return;
  if (!ctx.objects) throw new Error('object storage is not configured');
  const images: { data: Buffer; mimeType: string }[] = [];
  for (const p of prep.photos) {
    // The blurred review copy, never the restricted original (PHO-07).
    const key = (p.derivative_keys as Record<string, string>)['review'];
    if (!key) continue;
    const obj = await ctx.objects.get(key);
    images.push({ data: obj.body, mimeType: 'image/webp' });
  }
  if (!images.length) return;
  const call = await callAi(() => prep.provider.classifier!.classify(images, prep.context));
  await asSystem(ctx.db, tenantId, async (trx) => {
    const outputId = await recordAiOutput(trx, {
      tenantId,
      feature: 'photo.severity',
      provider: call.ok ? call.out.provider : prep.provider.info,
      outcome: call.ok ? 'ok' : call.outcome,
      latencyMs: call.ok ? call.out.latencyMs : call.latencyMs,
      executionId: msg.executionId ?? null,
      targetType: 'report',
      targetId: reportId,
    });
    if (!call.ok) {
      ctx.log.warn({ reportId, outcome: call.outcome }, 'severity suggestion failed');
      return;
    }
    const s = call.out.output;
    const row = await trx
      .insertInto('cg.damage_suggestion')
      .values({
        tenant_id: tenantId,
        report_id: reportId,
        degree: s.degree,
        confidence: Math.round(s.confidence * 1000) / 1000,
        visible_features: s.visibleFeatures,
        photo_ids: prep.ids,
        provider: call.out.provider.provider,
        model: call.out.provider.model,
        template_version: call.out.provider.templateVersion ?? null,
        ai_output_id: outputId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await systemAudit(trx, tenantId, 'report.severity', {
      action: 'report.severity_suggested',
      targetType: 'report',
      targetId: reportId,
      executionId: msg.executionId ?? null,
      changes: {
        fields: [
          { name: 'suggestion', to: row.id },
          { name: 'photos', to: prep.ids.length },
        ],
      },
    });
  });
};
