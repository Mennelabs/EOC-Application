/**
 * Report follow-ups from the outbox (RES-01/02, RULE-09, NED-03,
 * BRD:FR-12.03): a reviewer's request for information reaches the resident
 * on the channel they opted into; a withdrawal is acknowledged; consent and
 * correction events are recorded here for the layers that act on them
 * (partner sharing in layer 3, reviewer notices in the console).
 */
import type { Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { asSystem, enqueueOutbox } from '../system.ts';
import type { JobContext, TopicHandler } from './types.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

interface ReporterContact {
  partyId: string;
  phone: string | null;
  email: string | null;
  smsOptIn: boolean;
  language: string;
  referenceCode: string;
}

/** The reporter's contact details for a report, decrypted for this job only. */
export async function reporterContact(
  ctx: JobContext,
  trx: Transaction<Database>,
  tenantId: string,
  reportId: string,
): Promise<ReporterContact | null> {
  const row = await trx
    .selectFrom('cg.report')
    .innerJoin('cg.party', 'cg.party.id', 'cg.report.reporter_party_id')
    .select([
      'cg.party.id as party_id',
      'cg.party.contact_enc as contact_enc',
      'cg.party.sms_opt_in as sms_opt_in',
      'cg.party.language as language',
      'cg.report.reference_code as reference_code',
    ])
    .where('cg.report.id', '=', reportId)
    .executeTakeFirst();
  if (!row) return null;
  const contact = row.contact_enc
    ? (JSON.parse(await ctx.crypto.decrypt(tenantId, row.contact_enc)) as {
        phone?: string;
        email?: string;
      })
    : {};
  return {
    partyId: row.party_id,
    phone: contact.phone ?? null,
    email: contact.email ?? null,
    smsOptIn: row.sms_opt_in,
    language: row.language,
    referenceCode: row.reference_code,
  };
}

/** Picks the channel the resident agreed to: text with opt-in, else email, else nothing. */
function channelFor(c: ReporterContact): { channel: 'sms' | 'email'; to: string } | null {
  if (c.phone && c.smsOptIn) return { channel: 'sms', to: c.phone };
  if (c.email) return { channel: 'email', to: c.email };
  return null;
}

async function notifyReporter(
  ctx: JobContext,
  trx: Transaction<Database>,
  tenantId: string,
  reportId: string,
  template: string,
  variables: Record<string, string>,
): Promise<'sms' | 'email' | 'none'> {
  const contact = await reporterContact(ctx, trx, tenantId, reportId);
  const route = contact ? channelFor(contact) : null;
  if (!contact || !route) return 'none';
  await enqueueOutbox(trx, tenantId, 'message.send', {
    template,
    channel: route.channel,
    toEnc: (await ctx.crypto.encrypt(tenantId, route.to)).toString('base64'),
    language: contact.language,
    reportId,
    partyId: contact.partyId,
    variables: { referenceCode: contact.referenceCode, ...variables },
  });
  return route.channel;
}

/** correction.requested: a reviewer asked the resident something (BRD:FR-12.03). */
export const correctionRequested: TopicHandler = async (ctx, msg) => {
  const id = str(msg.payload['correctionRequestId']);
  await asSystem(ctx.db, msg.tenantId, async (trx) => {
    const req = await trx
      .selectFrom('cg.correction_request')
      .select(['id', 'report_id', 'message', 'sent_via'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!req || req.sent_via) return; // unknown or already sent
    const via = await notifyReporter(ctx, trx, msg.tenantId, req.report_id, 'correction_request', {
      ...(req.message ? { note: req.message } : {}),
    });
    await trx
      .updateTable('cg.correction_request')
      .set({ sent_via: via })
      .where('id', '=', req.id)
      .execute();
  });
};

/** report.withdrawn: acknowledge on the resident's channel (RES-02). */
export const reportWithdrawn: TopicHandler = async (ctx, msg) => {
  const reportId = str(msg.payload['reportId']);
  await asSystem(ctx.db, msg.tenantId, async (trx) => {
    await notifyReporter(ctx, trx, msg.tenantId, reportId, 'withdrawn', {});
  });
};

/** consent.changed: nothing is shared yet (partner sharing is layer 3); the change is already audited. */
export const consentChanged: TopicHandler = async (ctx, msg) => {
  ctx.log.debug(
    { reportId: msg.payload['reportId'], orgType: msg.payload['orgType'] },
    'consent changed; sharing adjusts in layer 3',
  );
};

/** report.corrected: the resident changed answers; a reopened report is back in the queue by state. */
export const reportCorrected: TopicHandler = async (ctx, msg) => {
  ctx.log.debug(
    { reportId: msg.payload['reportId'], reopened: msg.payload['reopened'] },
    'report corrected',
  );
};
