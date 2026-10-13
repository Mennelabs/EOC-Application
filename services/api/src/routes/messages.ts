/**
 * Resident updates and replies on a report (FL-11, BRD:FR-17.04/17.05,
 * RULE-17, SEC-10/18, AIG-10): county staff, or a partner organization
 * holding a grant with the contact section, send a short plain-language
 * update to a resident who opted in (text) or gave an email; the text passes
 * the output filter before it is queued; the worker sends it and records the
 * message state; a reply from the resident's number lands on the same report
 * (channels/session.ts). Bodies and addresses are restricted on read.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { filterGeneratedText } from '@cg/ai';
import type { FieldDescriptor } from '@cg/authz';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';
import { enqueueOutbox, iso, listQuery, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;

const FIELDS: FieldDescriptor[] = [
  { name: 'body', category: 'free_text', classification: 'restricted' },
  { name: 'to', category: 'contact', classification: 'restricted' },
];

const messageOut = z.object({
  id: z.uuid(),
  direction: z.enum(['outbound', 'inbound']),
  channel: z.string(),
  template: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  to: z.string().nullable(),
  queuedAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

export const messageRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  /** The report's county and whether the subject reaches it through a grant with the contact section. */
  async function locate(request: FastifyRequest, reportId: string) {
    const s = account(request);
    const own = await request.tx((trx) =>
      trx
        .selectFrom('cg.report')
        .select(['id', 'tenant_id', 'event_id'])
        .where('id', '=', reportId)
        .executeTakeFirst(),
    );
    if (own) return { countyId: own.tenant_id, eventId: own.event_id, viaGrant: false };
    const grant = await request.tx((trx) =>
      trx
        .selectFrom('cg.share_grant')
        .select(['tenant_id', 'id'])
        .where('to_tenant_id', '=', s.tenantId)
        .where('report_id', '=', reportId)
        .where('revoked_at', 'is', null)
        .where(sql<boolean>`'contact' = any(sections)`)
        .executeTakeFirst(),
    );
    if (!grant) throw errors.notFound();
    return { countyId: grant.tenant_id, eventId: null, viaGrant: true, grantId: grant.id };
  }

  const inCounty = <T>(request: FastifyRequest, countyId: string, fn: (trx: Trx) => Promise<T>) =>
    account(request).tenantId === countyId ? request.tx(fn) : request.txAs(countyId, fn);

  app.post(
    '/reports/:id/messages',
    {
      schema: {
        tags: ['messages'],
        params: uuidParam,
        body: z.object({
          text: z.string().min(3).max(480),
          channel: z.enum(['sms', 'email']).optional(),
        }),
        response: {
          202: z.object({
            queued: z.boolean(),
            channel: z.enum(['sms', 'email']).nullable(),
            reason: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const where = await locate(request, request.params.id);
      await request.authorize('message.send', {
        type: 'message',
        tenantId: s.tenantId,
        ...(where.eventId ? { eventId: where.eventId } : {}),
      });
      const text = request.body.text.trim();
      const filtered = filterGeneratedText(text);
      if (!filtered.allowed)
        throw errors.validation(
          filtered.reasons.map((r) => ({ name: 'text', message: `not sent: ${r}` })),
        );
      const result = await inCounty(request, where.countyId, async (trx) => {
        const report = await trx
          .selectFrom('cg.report')
          .innerJoin('cg.party', 'cg.party.id', 'cg.report.reporter_party_id')
          .select([
            'cg.report.id as id',
            'cg.report.reference_code as code',
            'cg.report.execution_id as execution_id',
            'cg.party.id as party_id',
            'cg.party.contact_enc as contact_enc',
            'cg.party.sms_opt_in as sms_opt_in',
            'cg.party.language as language',
          ])
          .where('cg.report.id', '=', request.params.id)
          .where('cg.report.withdrawn_at', 'is', null)
          .executeTakeFirst();
        if (!report) throw errors.notFound();
        const contact = report.contact_enc
          ? (JSON.parse(await app.fieldCrypto.decrypt(where.countyId, report.contact_enc)) as {
              phone?: string;
              email?: string;
            })
          : {};
        const sender = await trx
          .selectFrom('cg.tenant')
          .select('name')
          .where('id', '=', s.tenantId)
          .executeTakeFirstOrThrow();
        const wanted = request.body.channel;
        // docs/06: texts only with opt-in; email otherwise; nothing when the resident left no way.
        let channel: 'sms' | 'email' | null = null;
        let to: string | null = null;
        if ((!wanted || wanted === 'sms') && contact.phone && report.sms_opt_in) {
          channel = 'sms';
          to = contact.phone;
        } else if ((!wanted || wanted === 'email') && contact.email) {
          channel = 'email';
          to = contact.email;
        }
        if (!channel || !to)
          return { queued: false, channel: null, reason: 'no opted-in channel on file' };
        await enqueueOutbox(
          trx,
          where.countyId,
          'message.send',
          {
            template: 'staff_update',
            channel,
            toEnc: (await app.fieldCrypto.encrypt(where.countyId, to)).toString('base64'),
            language: report.language,
            reportId: report.id,
            partyId: report.party_id,
            variables: { referenceCode: report.code, text, sender: sender.name },
          },
          report.execution_id,
        );
        await request.audit(trx, {
          tenantId: where.countyId,
          action: 'message.send',
          targetType: 'report',
          targetId: report.id,
          changes: {
            fields: [
              { name: 'channel', to: channel },
              { name: 'length', to: text.length },
              { name: 'sender_tenant', to: s.tenantId },
            ],
          },
        });
        return { queued: true, channel, reason: null };
      });
      return reply.code(202).send(result);
    },
  );

  app.get(
    '/reports/:id/messages',
    {
      schema: {
        tags: ['messages'],
        params: uuidParam,
        querystring: listQuery,
        response: { 200: z.array(messageOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const where = await locate(request, request.params.id);
      const decision = await request.authorize('message.read', {
        type: 'message',
        tenantId: s.tenantId,
        ...(where.eventId ? { eventId: where.eventId } : {}),
        fields: FIELDS,
      });
      const rows = await inCounty(request, where.countyId, (trx) =>
        trx
          .selectFrom('cg.message')
          .selectAll()
          .where('report_id', '=', request.params.id)
          .orderBy('created_at', 'desc')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      const can = (f: string) => decision.fields.includes(f);
      const out = [];
      for (const m of rows)
        out.push({
          id: m.id,
          direction: m.direction,
          channel: m.channel,
          template: m.template,
          state: m.state,
          body: can('body') ? await app.fieldCrypto.decrypt(where.countyId, m.body_enc) : null,
          to: can('to') ? await app.fieldCrypto.decrypt(where.countyId, m.to_enc) : null,
          queuedAt: iso(m.queued_at)!,
          sentAt: iso(m.sent_at),
          deliveredAt: iso(m.delivered_at),
          failedAt: iso(m.failed_at),
          error: m.error,
        });
      if (decision.restrictedRead.length > 0 && rows.length > 0)
        await inCounty(request, where.countyId, (trx) =>
          request.audit(trx, {
            tenantId: where.countyId,
            action: 'message.read',
            targetType: 'report',
            targetId: request.params.id,
            classificationRead: decision.restrictedRead,
            changes: { fields: [{ name: 'count', to: rows.length }] },
          }),
        );
      return out;
    },
  );
};
