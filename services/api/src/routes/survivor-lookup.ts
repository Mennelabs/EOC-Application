/**
 * Finding a survivor's record without their code (FL-02). A frontline worker
 * who holds `survivor.find` finds a resident's report in two ways, and each
 * time the survivor shows it is them before anything about the record is
 * shown:
 *
 * - by phone: the county texts the survivor a one-time code through its own
 *   number (the same message residents get when they look up their report).
 *   The survivor reads it to the worker, and only then are the reports on that
 *   phone listed;
 * - by address and name: the reports at that street whose sender's name
 *   matches are offered with only the day they came in and how. The worker
 *   reads them back; when the survivor says one is theirs, the worker
 *   confirms it, and only then is its reference code shown.
 *
 * The answers never say whether a phone is on file before the code is read
 * back (RULE-17). Each worker is rate-limited, every step is audited, and
 * only reports the worker may read are offered. The reference code then
 * opens the record as FL-01 does, within the worker's permissions and the
 * survivor's consent.
 */
import { randomInt } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { decide, type AccountSubject } from '@cg/authz';
import { normalisePhone } from '@cg/crypto';
import { ApiError, errors } from '../errors.ts';
import { WindowCounter } from '../public/abuse.ts';
import { sha } from '../public/submit.ts';
import { enqueueOutbox, iso } from './helpers.ts';

/** Texts a worker may ask for in an hour; each one reaches a resident's phone. */
export const PHONE_LOOKUPS_PER_HOUR = 10;
/** Address searches and code checks a worker may make in an hour. */
export const ADDRESS_LOOKUPS_PER_HOUR = 20;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const CANDIDATES = 50;

const foundOut = z.object({
  reportId: z.uuid(),
  referenceCode: z.string(),
  eventId: z.uuid().nullable(),
  submittedAt: z.iso.datetime(),
  channel: z.string(),
  reviewState: z.string(),
});
const candidateOut = z.object({
  reportId: z.uuid(),
  submittedAt: z.iso.datetime(),
  channel: z.string(),
});

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Every word the worker typed is in the name the survivor gave, in any order. */
export function nameMatches(typed: string, stored: string): boolean {
  const want = norm(typed).split(' ').filter(Boolean);
  if (want.length === 0) return false;
  const have = new Set(norm(stored).split(' ').filter(Boolean));
  return want.every((w) => have.has(w));
}

/** The street line exactly as the intake worker keys it (worker intake.ts addressKeyOf). */
export const streetKey = (line1: string) =>
  line1
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const survivorLookupRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const texts = new WindowCounter(60 * 60_000);
  const searches = new WindowCounter(60 * 60_000);

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const limit = (counter: WindowCounter, key: string, max: number) => {
    if (counter.hit(key) > max)
      throw new ApiError(
        429,
        'too_many_attempts',
        'Too many lookups this hour. Ask a coordinator, or try again later.',
        { retryable: true },
      );
  };
  const mayRead = (s: AccountSubject, r: { tenant_id: string; event_id: string | null }) =>
    decide(s, 'report.read', {
      type: 'report',
      tenantId: r.tenant_id,
      ...(r.event_id ? { eventId: r.event_id } : {}),
    }).effect === 'allow';

  // ------------------------------------------------------------- by phone
  app.post(
    '/survivor-lookup/phone',
    {
      schema: {
        tags: ['frontline'],
        body: z.object({ phone: z.string().trim().min(7).max(30) }),
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('survivor.find', { type: 'report', tenantId: s.tenantId });
      limit(texts, s.accountId, PHONE_LOOKUPS_PER_HOUR);
      const phone = normalisePhone(request.body.phone);
      const bidx = await app.fieldCrypto.blindIndex(s.tenantId, 'phone', phone);
      await request.tx(async (trx) => {
        const latest = await trx
          .selectFrom('cg.report as r')
          .innerJoin('cg.party as p', 'p.id', 'r.reporter_party_id')
          .select(['r.id', 'p.language'])
          .where('p.phone_bidx', '=', bidx)
          .where('r.withdrawn_at', 'is', null)
          .orderBy('r.submitted_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (!latest) return;
        const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await trx
          .insertInto('cg.otp_challenge')
          .values({
            tenant_id: s.tenantId,
            report_id: latest.id,
            contact_bidx: bidx,
            channel: 'sms',
            code_hash: sha([s.tenantId, latest.id, otp]),
            expires_at: new Date(Date.now() + CODE_MINUTES * 60_000),
          })
          .execute();
        // The code travels encrypted to the sender, never in the queue in plain text.
        await enqueueOutbox(
          trx,
          s.tenantId,
          'message.send',
          {
            template: 'otp',
            channel: 'sms',
            toEnc: (await app.fieldCrypto.encrypt(s.tenantId, phone)).toString('base64'),
            language: latest.language,
            reportId: latest.id,
            variables: {},
            secretVariablesEnc: (
              await app.fieldCrypto.encrypt(s.tenantId, JSON.stringify({ code: otp }))
            ).toString('base64'),
          },
          request.executionId,
        );
        await request.audit(trx, {
          action: 'survivor.find',
          targetType: 'report',
          targetId: latest.id,
          changes: { fields: [{ name: 'phone', to: 'code sent' }] },
        });
      });
      // RULE-17: the same answer whether or not the number is on a report.
      return reply.code(202).send({
        status: 'sent',
        message:
          'If that number is on a report, the survivor gets a text with a code. Ask them to read it to you.',
      });
    },
  );

  app.post(
    '/survivor-lookup/phone/verify',
    {
      schema: {
        tags: ['frontline'],
        body: z.object({
          phone: z.string().trim().min(7).max(30),
          code: z.string().regex(/^\d{6}$/),
        }),
        response: { 200: z.object({ reports: z.array(foundOut) }) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('survivor.find', { type: 'report', tenantId: s.tenantId });
      limit(searches, s.accountId, ADDRESS_LOOKUPS_PER_HOUR);
      const bidx = await app.fieldCrypto.blindIndex(
        s.tenantId,
        'phone',
        normalisePhone(request.body.phone),
      );
      const found = await request.tx(async (trx) => {
        const challenge = await trx
          .selectFrom('cg.otp_challenge')
          .select(['id', 'report_id', 'code_hash', 'attempts'])
          .where('contact_bidx', '=', bidx)
          .where('consumed_at', 'is', null)
          .where('expires_at', '>', new Date())
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (!challenge || challenge.attempts >= MAX_ATTEMPTS) return null;
        const ok = challenge.code_hash.equals(
          sha([s.tenantId, challenge.report_id, request.body.code]),
        );
        await trx
          .updateTable('cg.otp_challenge')
          .set(
            ok
              ? { consumed_at: new Date(), attempts: challenge.attempts + 1 }
              : { attempts: challenge.attempts + 1 },
          )
          .where('id', '=', challenge.id)
          .execute();
        if (!ok) return null;
        const rows = await trx
          .selectFrom('cg.report as r')
          .innerJoin('cg.party as p', 'p.id', 'r.reporter_party_id')
          .select([
            'r.id',
            'r.tenant_id',
            'r.reference_code',
            'r.event_id',
            'r.submitted_at',
            'r.channel_of_origin',
            'r.review_state',
          ])
          .where('p.phone_bidx', '=', bidx)
          .where('r.withdrawn_at', 'is', null)
          .orderBy('r.submitted_at', 'desc')
          .limit(20)
          .execute();
        const visible = rows.filter((r) => mayRead(s, r));
        for (const r of visible)
          await request.audit(trx, {
            action: 'survivor.find',
            targetType: 'report',
            targetId: r.id,
            changes: { fields: [{ name: 'phone', to: 'code read back by the survivor' }] },
          });
        return visible;
      });
      if (!found)
        throw new ApiError(
          401,
          'code_invalid',
          'That code did not match. Check it with the survivor, or send a new one.',
        );
      return {
        reports: found.map((r) => ({
          reportId: r.id,
          referenceCode: r.reference_code,
          eventId: r.event_id,
          submittedAt: iso(r.submitted_at)!,
          channel: r.channel_of_origin,
          reviewState: r.review_state,
        })),
      };
    },
  );

  // ----------------------------------------------------- by address and name
  app.post(
    '/survivor-lookup/address',
    {
      schema: {
        tags: ['frontline'],
        body: z.object({
          line1: z.string().trim().min(3).max(200),
          postal: z
            .string()
            .trim()
            .regex(/^\d{5}(-\d{4})?$/)
            .optional(),
          name: z.string().trim().min(2).max(200),
        }),
        response: { 200: z.object({ candidates: z.array(candidateOut) }) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('survivor.find', { type: 'report', tenantId: s.tenantId });
      limit(searches, s.accountId, ADDRESS_LOOKUPS_PER_HOUR);
      const street = streetKey(request.body.line1);
      const postal = request.body.postal?.slice(0, 5);
      const candidates = await request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cg.report as r')
          .innerJoin('cg.location as l', 'l.id', 'r.location_id')
          .innerJoin('cg.party as p', 'p.id', 'r.reporter_party_id')
          .select([
            'r.id',
            'r.tenant_id',
            'r.event_id',
            'r.submitted_at',
            'r.channel_of_origin',
            'l.address_key',
            'p.display_name_enc',
          ])
          .where('r.withdrawn_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('l.address_key', '=', street),
              eb('l.address_key', 'like', `${street.replace(/[%_\\]/g, '')}|%`),
            ]),
          )
          .orderBy('r.submitted_at', 'desc')
          .limit(CANDIDATES)
          .execute();
        const out: typeof rows = [];
        for (const r of rows) {
          if (postal && !(r.address_key ?? '').split('|').includes(postal)) continue;
          if (!r.display_name_enc || !mayRead(s, r)) continue;
          const name = await app.fieldCrypto.decrypt(s.tenantId, r.display_name_enc);
          if (nameMatches(request.body.name, name)) out.push(r);
        }
        await request.audit(trx, {
          action: 'survivor.find',
          targetType: 'report',
          targetId: out.length ? out.map((r) => r.id).join(',') : 'none',
          changes: {
            fields: [{ name: 'address and name', to: `${out.length} offered for confirmation` }],
          },
        });
        return out;
      });
      return {
        candidates: candidates.map((r) => ({
          reportId: r.id,
          submittedAt: iso(r.submitted_at)!,
          channel: r.channel_of_origin,
        })),
      };
    },
  );

  app.post(
    '/survivor-lookup/confirm',
    {
      schema: {
        tags: ['frontline'],
        body: z.object({
          reportId: z.uuid(),
          /** What the survivor recognised, in the worker's words, for the audit. */
          note: z.string().trim().max(500).optional(),
        }),
        response: { 200: foundOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('survivor.find', { type: 'report', tenantId: s.tenantId });
      const r = await request.tx(async (trx) => {
        const row = await trx
          .selectFrom('cg.report')
          .select([
            'id',
            'tenant_id',
            'reference_code',
            'event_id',
            'submitted_at',
            'channel_of_origin',
            'review_state',
          ])
          .where('id', '=', request.body.reportId)
          .where('withdrawn_at', 'is', null)
          .executeTakeFirst();
        if (!row || !mayRead(s, row)) return null;
        await request.audit(trx, {
          action: 'survivor.find',
          targetType: 'report',
          targetId: row.id,
          reason: request.body.note ?? 'The survivor confirmed it is them',
          changes: { fields: [{ name: 'address and name', to: 'confirmed by the survivor' }] },
        });
        return row;
      });
      if (!r) throw errors.notFound();
      return {
        reportId: r.id,
        referenceCode: r.reference_code,
        eventId: r.event_id,
        submittedAt: iso(r.submitted_at)!,
        channel: r.channel_of_origin,
        reviewState: r.review_state,
      };
    },
  );
};
