/**
 * Outbound messages to residents (CHN-03, RULE-17, SEC-10, ADM-03): every
 * message is a row in cg.message with its state; the recipient and the body
 * are encrypted, the template name is in clear for metrics. Email goes
 * through the mail adapter, texts through the SMS adapter. A text goes only
 * to a number that opted in, except the one-time code the resident asked for.
 * Idempotent by outbox message id, so a redelivery never sends twice.
 */
import { sql } from 'kysely';
import { z } from 'zod';
import { asSystem, systemAudit } from '../system.ts';
import { isTemplateName, renderTemplate, type TemplateVars } from './templates.ts';
import type { JobContext, TopicHandler } from './types.ts';
import { integrationCalls } from '../metrics.ts';

export const messagePayloadSchema = z.object({
  template: z.string().min(1),
  channel: z.enum(['sms', 'email']),
  /** Recipient, encrypted by the sender (base64 of the field-crypto blob). */
  toEnc: z.string().min(1),
  language: z.string().default('en'),
  reportId: z.uuid().optional(),
  partyId: z.uuid().optional(),
  /** A recall notice names the grant it recalls; the grant records the message (NED-05). */
  shareGrantId: z.uuid().optional(),
  /** A referral notice names its referral so a redelivery finds it (FL-10). */
  referralId: z.uuid().optional(),
  /** A field message's text fallback names its receipt, which records the message row (DSP-06). */
  fieldReceiptId: z.uuid().optional(),
  /** An appointment's notice or reminder names the appointment, which records the message (FL:FR-18). */
  appointmentId: z.uuid().optional(),
  appointmentNotice: z.enum(['notice', 'reminder']).optional(),
  variables: z.record(z.string(), z.string()).default({}),
  /**
   * Variables that must not sit in the outbox in clear, such as a single-use link (REC-01):
   * a JSON object encrypted by the sender, merged over `variables` when the message is made.
   */
  secretVariablesEnc: z.string().min(1).optional(),
});

/** Where a resident opens their own report (the resident app serves this path). */
export function myReportUrl(ctx: JobContext, tenantSlug: string): string {
  return `${ctx.urls.gatewayPublic}/${tenantSlug}/my-report`;
}

export const messageSend: TopicHandler = async (ctx, msg) => {
  const p = messagePayloadSchema.parse(msg.payload);
  if (!isTemplateName(p.template)) throw new Error(`unknown message template ${p.template}`);
  const template = p.template;
  const tenantId = msg.tenantId;
  const to = await ctx.crypto.decrypt(tenantId, Buffer.from(p.toEnc, 'base64'));

  // 1. The row, before anything leaves (a redelivery finds it).
  const prepared = await asSystem(ctx.db, tenantId, async (trx) => {
    const existing = await trx
      .selectFrom('cg.message')
      .select(['id', 'state', 'body_enc'])
      .where(sql`provider_evidence->>'outboxId'`, '=', String(msg.id))
      .executeTakeFirst();
    if (existing && existing.state !== 'queued' && existing.state !== 'failed') return null;
    const tenant = await trx
      .selectFrom('cg.tenant')
      .select(['name', 'slug'])
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow();
    // This county's help line, never another's (the worker sees every tenant).
    const help = await trx
      .selectFrom('cg.tenant_config')
      .select('value')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', 'intake.help_phone')
      .executeTakeFirst();
    const number =
      p.channel === 'sms'
        ? await trx
            .selectFrom('cg.channel_number')
            .select('number')
            .where('tenant_id', '=', tenantId)
            .where(sql<boolean>`'sms' = any(capabilities)`)
            .orderBy('created_at')
            .executeTakeFirst()
        : undefined;
    const party = p.partyId
      ? await trx
          .selectFrom('cg.party')
          .select(['sms_opt_in'])
          .where('id', '=', p.partyId)
          .executeTakeFirst()
      : null;
    const secret = p.secretVariablesEnc
      ? (JSON.parse(
          await ctx.crypto.decrypt(tenantId, Buffer.from(p.secretVariablesEnc, 'base64')),
        ) as Record<string, string>)
      : {};
    const vars: TemplateVars = {
      county: tenant.name,
      helpPhone: typeof help?.value === 'string' ? help.value : null,
      url: myReportUrl(ctx, tenant.slug),
      ...p.variables,
      ...secret,
    };
    const rendered = renderTemplate(template, p.language, p.channel, vars);
    const id =
      existing?.id ??
      (
        await trx
          .insertInto('cg.message')
          .values({
            tenant_id: tenantId,
            channel: p.channel,
            to_bidx: await ctx.crypto.blindIndex(
              tenantId,
              p.channel === 'sms' ? 'phone' : 'email',
              to,
            ),
            to_enc: await ctx.crypto.encrypt(tenantId, to),
            template,
            body_enc: await ctx.crypto.encrypt(tenantId, rendered.body),
            provider_evidence: JSON.stringify({ outboxId: msg.id }),
            report_id: p.reportId ?? null,
            party_id: p.partyId ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    if (p.fieldReceiptId)
      await trx
        .updateTable('cg.field_message_receipt')
        .set({ sms_message_id: id, channel: 'sms' })
        .where('id', '=', p.fieldReceiptId)
        .execute();
    if (p.appointmentId && p.appointmentNotice)
      await trx
        .updateTable('cg.appointment')
        .set(
          p.appointmentNotice === 'notice'
            ? { notice_message_id: id }
            : { reminder_message_id: id },
        )
        .where('id', '=', p.appointmentId)
        .execute();
    if (p.shareGrantId)
      await trx
        .updateTable('cg.share_grant')
        .set({ recall_notice_message_id: id })
        .where('id', '=', p.shareGrantId)
        .where('recall_notice_message_id', 'is', null)
        .execute();
    // docs/06: no texts without opt-in; the one-time code is the resident's own request.
    if (p.channel === 'sms' && party && !party.sms_opt_in && template !== 'otp') {
      await trx
        .updateTable('cg.message')
        .set({ state: 'failed', error: 'no_sms_opt_in', failed_at: new Date() })
        .where('id', '=', id)
        .execute();
      await systemAudit(trx, tenantId, 'message.send', {
        action: 'message.suppressed',
        targetType: 'message',
        targetId: id,
        reason: 'no SMS opt-in on file',
      });
      return null;
    }
    return { id, rendered, from: number?.number ?? null };
  });
  if (!prepared) return;

  // 2. Send outside the transaction; 3. record the outcome.
  try {
    let provider: string;
    let providerMessageId: string | null = null;
    let evidence: Record<string, unknown> = { outboxId: msg.id };
    if (p.channel === 'email') {
      await ctx.mail.send({
        to,
        subject:
          prepared.rendered.subject ?? `Message from ${p.variables['county'] ?? 'your county'}`,
        text: prepared.rendered.body,
      });
      provider = 'smtp';
      integrationCalls.inc({ integration: 'email', outcome: 'ok' });
    } else {
      const receipt = await ctx.sms.send({
        to,
        body: prepared.rendered.body,
        ...(prepared.from ? { from: prepared.from } : {}),
      });
      integrationCalls.inc({ integration: 'sms', outcome: 'ok' });
      provider = receipt.provider;
      providerMessageId = receipt.providerMessageId;
      evidence = { ...evidence, segments: receipt.segments, status: receipt.status };
    }
    await asSystem(ctx.db, tenantId, async (trx) => {
      await trx
        .updateTable('cg.message')
        .set({
          state: 'sent',
          sent_at: new Date(),
          provider,
          provider_message_id: providerMessageId,
          provider_evidence: JSON.stringify(evidence),
          error: null,
        })
        .where('id', '=', prepared.id)
        .execute();
      await systemAudit(trx, tenantId, 'message.send', {
        action: 'message.sent',
        targetType: 'message',
        targetId: prepared.id,
        changes: {
          fields: [
            { name: 'template', to: template },
            { name: 'channel', to: p.channel },
            { name: 'provider', to: provider },
          ],
        },
      });
    });
  } catch (err) {
    integrationCalls.inc({
      integration: p.channel === 'email' ? 'email' : 'sms',
      outcome: 'failed',
    });
    await asSystem(ctx.db, tenantId, (trx) =>
      trx
        .updateTable('cg.message')
        .set({
          state: 'failed',
          failed_at: new Date(),
          error: String(err instanceof Error ? err.message : err).slice(0, 500),
        })
        .where('id', '=', prepared.id)
        .execute(),
    );
    throw err; // the broker redelivers; the row above makes the retry resend, not duplicate
  }
};
