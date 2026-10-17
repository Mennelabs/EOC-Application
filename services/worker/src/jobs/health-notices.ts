/**
 * Tells residents of a health notice (FL:FR-06). When a notice is approved,
 * each resident whose report or help request is in its area, and who agreed
 * to be contacted, gets one text or one email in their language (plan
 * reading 30); when it ends, the residents who were told of it can be told it
 * has ended. The ledger (notice, party, phase) makes every message happen
 * once, whatever the redelivery, and the same phone or email reached through
 * two reports is told once. A notice ended before its messages went out
 * sends nothing. The notice records counts only.
 */
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { noticeChannel, partiesInNoticeArea, type Database, type NoticeParty } from '@cg/db';
import { asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import type { TopicHandler } from './types.ts';

const payloadSchema = z.object({ noticeId: z.uuid(), phase: z.enum(['issued', 'ended']) });

/** A text carries a short title and the link; the email and the public page carry the rest. */
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s);

const ENDED = {
  en: { lifted: 'lifted', withdrawn: 'withdrawn' },
  es: { lifted: 'levantado', withdrawn: 'retirado' },
} as const;

async function toldBefore(trx: Transaction<Database>, noticeId: string, phase: string) {
  const rows = await trx
    .selectFrom('cg.health_notice_recipient as r')
    .innerJoin('cg.party as p', 'p.id', 'r.party_id')
    .select(['r.channel', 'p.phone_bidx', 'p.email_bidx'])
    .where('r.notice_id', '=', noticeId)
    .where('r.phase', '=', phase as 'issued' | 'ended')
    .execute();
  return new Set(
    rows.map(
      (r) => `${r.channel}:${(r.channel === 'sms' ? r.phone_bidx : r.email_bidx)?.toString('hex')}`,
    ),
  );
}

export const healthNoticeSend: TopicHandler = async (ctx, msg) => {
  const p = payloadSchema.parse(msg.payload);
  const tenantId = msg.tenantId;
  await asSystem(ctx.db, tenantId, async (trx) => {
    const n = await trx
      .selectFrom('cg.health_notice')
      .selectAll()
      .select([
        sql<number | null>`ST_Y(center)`.as('lat'),
        sql<number | null>`ST_X(center)`.as('lon'),
      ])
      .where('id', '=', p.noticeId)
      .forUpdate()
      .executeTakeFirst();
    if (!n) return;
    // An issued notice that already ended tells nobody; an end is told only when asked for.
    if (p.phase === 'issued' && n.status !== 'active') return;
    if (p.phase === 'ended' && (n.status !== 'ended' || !n.tell_ended)) return;
    const tenant = await trx
      .selectFrom('cg.tenant')
      .select(['name', 'slug'])
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const url = `${ctx.urls.gatewayPublic}/${tenant.slug}/help`;

    // Who: the area for the notice itself; for its end, the residents told of it.
    const parties: NoticeParty[] =
      p.phase === 'issued'
        ? await partiesInNoticeArea(trx, {
            tenantId,
            zips: n.zips,
            lat: n.lat === null ? null : Number(n.lat),
            lon: n.lon === null ? null : Number(n.lon),
            radiusM: n.radius_m,
          })
        : await trx
            .selectFrom('cg.health_notice_recipient as r')
            .innerJoin('cg.party as p', 'p.id', 'r.party_id')
            .select([
              'p.id as party_id',
              'p.contact_enc',
              'p.phone_bidx',
              'p.email_bidx',
              'p.sms_opt_in',
              'p.language',
            ])
            .where('r.notice_id', '=', n.id)
            .where('r.phase', '=', 'issued')
            .where('p.contact_enc', 'is not', null)
            .execute();

    const seen = await toldBefore(trx, n.id, p.phase);
    const count = { sms: 0, email: 0 };
    let unreadable = 0;
    for (const party of parties) {
      // One contact that cannot be read must not stop the others from being told.
      const contact = await ctx.crypto
        .decrypt(tenantId, party.contact_enc!)
        .then((t) => JSON.parse(t) as { phone?: string; email?: string; preferred?: string })
        .catch(() => null);
      if (!contact) {
        unreadable += 1;
        continue;
      }
      const way = noticeChannel(contact, party.sms_opt_in);
      if (!way) continue;
      const key = `${way.channel}:${(way.channel === 'sms' ? party.phone_bidx : party.email_bidx)?.toString('hex')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const recorded = await trx
        .insertInto('cg.health_notice_recipient')
        .values({
          tenant_id: tenantId,
          notice_id: n.id,
          party_id: party.party_id,
          phase: p.phase,
          channel: way.channel,
        })
        .onConflict((oc) => oc.columns(['notice_id', 'party_id', 'phase']).doNothing())
        .returning('party_id')
        .executeTakeFirst();
      if (!recorded) continue;
      const spanish = party.language.toLowerCase().startsWith('es') && Boolean(n.title_es);
      const title = spanish ? n.title_es! : n.title_en;
      await enqueueOutbox(trx, tenantId, 'message.send', {
        template: p.phase === 'issued' ? 'health_notice' : 'health_notice_ended',
        channel: way.channel,
        toEnc: (await ctx.crypto.encrypt(tenantId, way.to)).toString('base64'),
        language: spanish ? 'es' : 'en',
        partyId: party.party_id,
        variables: {
          title: way.channel === 'sms' ? short(title) : title,
          text: spanish ? n.body_es! : n.body_en,
          area: n.area_label,
          url,
          ...(n.end_reason ? { what: ENDED[spanish ? 'es' : 'en'][n.end_reason] } : {}),
        },
      });
      count[way.channel] += 1;
    }
    const now = new Date();
    // A repeat run that told nobody new changes nothing: the notice keeps its version, so an
    // officer lifting it is not refused for a change they cannot see.
    const recordedAt = p.phase === 'issued' ? n.sent_at : n.ended_sent_at;
    if (count.sms + count.email > 0 || !recordedAt)
      await trx
        .updateTable('cg.health_notice')
        .set(
          p.phase === 'issued'
            ? {
                sent_sms: sql`sent_sms + ${count.sms}`,
                sent_email: sql`sent_email + ${count.email}`,
                sent_at: sql`coalesce(sent_at, ${now})`,
              }
            : {
                ended_sent_sms: sql`ended_sent_sms + ${count.sms}`,
                ended_sent_email: sql`ended_sent_email + ${count.email}`,
                ended_sent_at: sql`coalesce(ended_sent_at, ${now})`,
              },
        )
        .where('id', '=', n.id)
        .execute();
    await systemAudit(trx, tenantId, 'health_notice.send', {
      action: 'health_notice.sent',
      targetType: 'health_notice',
      targetId: n.id,
      executionId: msg.executionId,
      changes: {
        fields: [
          { name: 'phase', to: p.phase },
          { name: 'sms', to: count.sms },
          { name: 'email', to: count.email },
          { name: 'unreadable_contacts', to: unreadable },
        ],
      },
    });
  });
};
