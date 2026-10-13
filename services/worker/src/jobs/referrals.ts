/**
 * referral.created (FL-10, BRD:FR-17.03): the receiving organization hears
 * about a referral by email, to the same people a recall notice reaches; the
 * notice names the record's reference code and the purpose, nothing else of
 * the resident's. Idempotent: a redelivery finds the message already queued.
 */
import { sql } from 'kysely';
import { asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import { partnerRecipients } from './sharing.ts';
import type { TopicHandler } from './types.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

export const referralCreated: TopicHandler = async (ctx, msg) => {
  const referralId = str(msg.payload['referralId']);
  await asSystem(ctx.db, msg.tenantId, async (trx) => {
    const referral = await trx
      .selectFrom('cg.referral as x')
      .leftJoin('cg.report as r', 'r.id', 'x.report_id')
      .leftJoin('cg.need as n', 'n.id', 'x.need_id')
      .select([
        'x.id',
        'x.to_tenant_id',
        'x.purpose',
        'x.report_id',
        sql<string | null>`coalesce(r.reference_code, n.reference_code)`.as('code'),
      ])
      .where('x.id', '=', referralId)
      .executeTakeFirst();
    if (!referral || !referral.to_tenant_id) return;
    const already = await trx
      .selectFrom('cg.outbox')
      .select('id')
      .where('topic', '=', 'message.send')
      .where(sql`payload->>'referralId'`, '=', referral.id)
      .executeTakeFirst();
    if (already) return;
    const { partnerName, emails } = await partnerRecipients(trx, referral.to_tenant_id);
    if (emails.length === 0) {
      await systemAudit(trx, msg.tenantId, 'referral.notify', {
        action: 'referral.notice_unsent',
        targetType: 'referral',
        targetId: referral.id,
        reason: `no recipient at partner ${referral.to_tenant_id}`,
      });
      return;
    }
    for (const email of emails)
      await enqueueOutbox(trx, msg.tenantId, 'message.send', {
        template: 'referral_notice',
        channel: 'email',
        toEnc: (await ctx.crypto.encrypt(msg.tenantId, email)).toString('base64'),
        language: 'en',
        ...(referral.report_id ? { reportId: referral.report_id } : {}),
        referralId: referral.id,
        variables: {
          referenceCode: referral.code ?? '',
          partner: partnerName,
          purpose: referral.purpose,
        },
      });
    await systemAudit(trx, msg.tenantId, 'referral.notify', {
      action: 'referral.notified',
      targetType: 'referral',
      targetId: referral.id,
      changes: { fields: [{ name: 'recipients', to: emails.length }] },
    });
  });
};
