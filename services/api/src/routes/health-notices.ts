/**
 * Targeted health notices (FL:FR-06): public health drafts a boil-water,
 * do-not-use-water or safety notice for an area, by ZIP code, a circle, or
 * both, in English and, when given, Spanish. Before anything is published or
 * sent, the reach is shown as counts only: how many residents in the area a
 * text or an email would go to, never who.
 *
 * Approval needs a second person (ADM-05 G4: never the drafter) and a stated
 * reason. It publishes the notice on the public "Find help" page and queues
 * one message per resident in the area who agreed to be contacted (plan
 * reading 30). Ending it, as lifted or withdrawn, takes it off the page and
 * can tell the same residents it has ended. Every step is audited.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { noticeChannel, partiesInNoticeArea, type Database, type HealthNoticeTable } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { enqueueOutbox, iso, uuidParam } from './helpers.ts';

const kinds = ['boil_water', 'do_not_use_water', 'safety'] as const;
const zip = z.string().regex(/^\d{5}$/, 'a five-digit ZIP code');

const textIn = z.object({
  title: z.string().trim().min(3).max(100),
  body: z.string().trim().min(3).max(2000),
});
const draftIn = z.object({
  eventId: z.uuid().optional(),
  kind: z.enum(kinds),
  en: textIn,
  es: textIn.optional(),
  /** The area in words as the public reads it, such as "Cedar Ridge water system". */
  areaLabel: z.string().trim().min(2).max(80),
  zips: z.array(zip).max(50).default([]),
  circle: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      radiusM: z.number().int().min(100).max(50_000),
    })
    .optional(),
  expiresAt: z.iso.datetime().optional(),
});

export const noticeOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  eventId: z.uuid().nullable(),
  kind: z.enum(kinds),
  en: textIn,
  es: textIn.nullable(),
  areaLabel: z.string(),
  zips: z.array(z.string()),
  circle: z.object({ lat: z.number(), lon: z.number(), radiusM: z.number() }).nullable(),
  status: z.enum(['draft', 'active', 'ended']),
  expiresAt: z.iso.datetime().nullable(),
  draftedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  endReason: z.enum(['lifted', 'withdrawn']).nullable(),
  /** Counts only, as queued when it was issued and when it ended. */
  sent: z.object({ sms: z.number().int(), email: z.number().int(), at: z.string().nullable() }),
  endedSent: z.object({
    sms: z.number().int(),
    email: z.number().int(),
    at: z.string().nullable(),
  }),
});

type Row = Selectable<HealthNoticeTable> & { lat: number | null; lon: number | null };

export const toNotice = (r: Row): z.infer<typeof noticeOut> => ({
  id: r.id,
  version: r.version,
  eventId: r.event_id,
  kind: r.kind,
  en: { title: r.title_en, body: r.body_en },
  es: r.title_es && r.body_es ? { title: r.title_es, body: r.body_es } : null,
  areaLabel: r.area_label,
  zips: r.zips,
  circle:
    r.lat !== null && r.lon !== null && r.radius_m !== null
      ? { lat: Number(r.lat), lon: Number(r.lon), radiusM: r.radius_m }
      : null,
  status: r.status,
  expiresAt: iso(r.expires_at),
  draftedBy: r.created_by,
  createdAt: iso(r.created_at)!,
  approvedBy: r.approved_by,
  approvedAt: iso(r.approved_at),
  endedAt: iso(r.ended_at),
  endReason: r.end_reason,
  sent: { sms: r.sent_sms, email: r.sent_email, at: iso(r.sent_at) },
  endedSent: { sms: r.ended_sent_sms, email: r.ended_sent_email, at: iso(r.ended_sent_at) },
});

export const healthNoticeRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const one = (trx: Transaction<Database>, id: string) =>
    trx
      .selectFrom('cg.health_notice')
      .selectAll()
      .select([
        sql<number | null>`ST_Y(center)`.as('lat'),
        sql<number | null>`ST_X(center)`.as('lon'),
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  const areaOf = (b: z.infer<typeof draftIn>) => {
    if (b.zips.length === 0 && !b.circle)
      throw errors.validation([
        { name: 'zips', message: 'name ZIP codes or a circle for the area' },
      ]);
    if (b.expiresAt && new Date(b.expiresAt).getTime() <= Date.now())
      throw errors.validation([{ name: 'expiresAt', message: 'a time in the future' }]);
  };
  const values = (b: z.infer<typeof draftIn>) => ({
    event_id: b.eventId ?? null,
    kind: b.kind,
    title_en: b.en.title,
    body_en: b.en.body,
    title_es: b.es?.title ?? null,
    body_es: b.es?.body ?? null,
    area_label: b.areaLabel,
    zips: [...new Set(b.zips)],
    center: b.circle ? sql`ST_SetSRID(ST_MakePoint(${b.circle.lon}, ${b.circle.lat}), 4326)` : null,
    radius_m: b.circle?.radiusM ?? null,
    expires_at: b.expiresAt ? new Date(b.expiresAt) : null,
  });

  app.get(
    '/health-notices',
    {
      schema: {
        tags: ['health notices'],
        querystring: z.object({ status: z.enum(['draft', 'active', 'ended']).optional() }),
        response: { 200: z.array(noticeOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('health_notice.read', {
        type: 'health_notice',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) => {
        let q = trx
          .selectFrom('cg.health_notice')
          .selectAll()
          .select([
            sql<number | null>`ST_Y(center)`.as('lat'),
            sql<number | null>`ST_X(center)`.as('lon'),
          ])
          .orderBy('created_at', 'desc')
          .limit(200);
        if (request.query.status) q = q.where('status', '=', request.query.status);
        return q.execute();
      });
      return rows.map(toNotice);
    },
  );

  app.post(
    '/health-notices',
    {
      schema: { tags: ['health notices'], body: draftIn, response: { 201: noticeOut } },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('health_notice.draft', {
        type: 'health_notice',
        tenantId: s.tenantId,
      });
      areaOf(request.body);
      const row = await request.tx(async (trx) => {
        const made = await trx
          .insertInto('cg.health_notice')
          .values({
            tenant_id: s.tenantId,
            ...values(request.body),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const r = (await one(trx, made.id))!;
        await request.audit(trx, {
          action: 'health_notice.draft',
          targetType: 'health_notice',
          targetId: r.id,
          targetVersion: r.version,
          changes: {
            fields: [
              { name: 'kind', to: r.kind },
              { name: 'area_label', to: r.area_label },
            ],
          },
        });
        return r;
      });
      return reply.code(201).send(toNotice(row));
    },
  );

  app.put(
    '/health-notices/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['health notices'],
        params: uuidParam,
        body: draftIn,
        response: { 200: noticeOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('health_notice.draft', {
        type: 'health_notice',
        tenantId: s.tenantId,
      });
      areaOf(request.body);
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const current = await one(trx, request.params.id);
        if (!current) throw errors.notFound();
        if (current.status !== 'draft')
          throw new ApiError(409, 'not_a_draft', 'Only a draft can be changed.');
        const result = await trx
          .updateTable('cg.health_notice')
          .set({ ...values(request.body), updated_by: s.accountId })
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returning('id')
          .executeTakeFirst();
        assertUpdated(result, current);
        const r = (await one(trx, current.id))!;
        await request.audit(trx, {
          action: 'health_notice.draft',
          targetType: 'health_notice',
          targetId: r.id,
          targetVersion: r.version,
        });
        return toNotice(r);
      });
    },
  );

  /** Counts only: residents in the area a text or an email would reach, deduplicated. */
  app.get(
    '/health-notices/:id/reach',
    {
      schema: {
        tags: ['health notices'],
        params: uuidParam,
        response: {
          200: z.object({
            sms: z.number().int(),
            email: z.number().int(),
            unreachable: z.number().int(),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('health_notice.read', {
        type: 'health_notice',
        tenantId: s.tenantId,
      });
      return request.tx(async (trx) => {
        const n = await one(trx, request.params.id);
        if (!n) throw errors.notFound();
        const parties = await partiesInNoticeArea(trx, {
          tenantId: n.tenant_id,
          zips: n.zips,
          lat: n.lat === null ? null : Number(n.lat),
          lon: n.lon === null ? null : Number(n.lon),
          radiusM: n.radius_m,
        });
        const seen = new Set<string>();
        const out = { sms: 0, email: 0, unreachable: 0 };
        for (const p of parties) {
          // A contact that cannot be read (damaged or under another key) is not reachable.
          const contact = await base.fieldCrypto
            .decrypt(n.tenant_id, p.contact_enc!)
            .then((t) => JSON.parse(t) as { phone?: string; email?: string; preferred?: string })
            .catch(() => null);
          if (!contact) {
            out.unreachable += 1;
            continue;
          }
          const way = noticeChannel(contact, p.sms_opt_in);
          if (!way) {
            out.unreachable += 1;
            continue;
          }
          const key = `${way.channel}:${(way.channel === 'sms' ? p.phone_bidx : p.email_bidx)?.toString('hex') ?? way.to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out[way.channel] += 1;
        }
        await request.audit(trx, {
          action: 'health_notice.read',
          targetType: 'health_notice',
          targetId: n.id,
          changes: {
            fields: [
              { name: 'reach_sms', to: out.sms },
              { name: 'reach_email', to: out.email },
            ],
          },
        });
        return out;
      });
    },
  );

  /** ADM-05 G4: a second person approves; it is published and residents are told once. */
  app.post(
    '/health-notices/:id/approve',
    {
      config: { requiresVersion: true },
      schema: { tags: ['health notices'], params: uuidParam, response: { 200: noticeOut } },
    },
    async (request) => {
      const s = account(request);
      const found = await request.tx((trx) => one(trx, request.params.id));
      if (!found) throw errors.notFound();
      await request.authorize(
        'health_notice.approve',
        {
          type: 'health_notice',
          id: found.id,
          tenantId: found.tenant_id,
          ...(found.created_by ? { recordedBy: found.created_by } : {}),
        },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const now = new Date();
        const result = await trx
          .updateTable('cg.health_notice')
          .set({
            status: 'active',
            approved_by: s.accountId,
            approved_at: now,
            updated_by: s.accountId,
          })
          .where('id', '=', found.id)
          .where('status', '=', 'draft')
          .where('version', '=', expected)
          .returning('id')
          .executeTakeFirst();
        if (!result) {
          const current = (await one(trx, found.id))!;
          if (current.status !== 'draft')
            throw new ApiError(409, 'not_a_draft', 'This notice was already approved or ended.');
          assertUpdated(result, current);
        }
        await enqueueOutbox(
          trx,
          found.tenant_id,
          'health_notice.send',
          { noticeId: found.id, phase: 'issued' },
          request.executionId ?? null,
        );
        const r = (await one(trx, found.id))!;
        await request.audit(trx, {
          action: 'health_notice.approve',
          targetType: 'health_notice',
          targetId: r.id,
          targetVersion: r.version,
          ...(reason ? { reason } : {}),
          changes: { fields: [{ name: 'status', from: 'draft', to: 'active' }] },
        });
        return toNotice(r);
      });
    },
  );

  /** Ends a notice as lifted or withdrawn; residents told of it can be told it ended. */
  app.post(
    '/health-notices/:id/end',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['health notices'],
        params: uuidParam,
        body: z.object({
          reason: z.enum(['lifted', 'withdrawn']),
          tellResidents: z.boolean().default(true),
        }),
        response: { 200: noticeOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await request.tx((trx) => one(trx, request.params.id));
      if (!found) throw errors.notFound();
      // Ending is not approving one's own work: the drafter may lift the notice they wrote.
      await request.authorize(
        'health_notice.approve',
        { type: 'health_notice', id: found.id, tenantId: found.tenant_id },
        { asNotFound: true },
      );
      const confirmation = request.confirmation();
      const expected = request.expectedVersion();
      const b = request.body;
      return request.tx(async (trx) => {
        const result = await trx
          .updateTable('cg.health_notice')
          .set({
            status: 'ended',
            ended_by: s.accountId,
            ended_at: new Date(),
            end_reason: b.reason,
            tell_ended: b.tellResidents,
            updated_by: s.accountId,
          })
          .where('id', '=', found.id)
          .where('status', '=', 'active')
          .where('version', '=', expected)
          .returning('id')
          .executeTakeFirst();
        if (!result) {
          const current = (await one(trx, found.id))!;
          if (current.status !== 'active')
            throw new ApiError(409, 'not_active', 'Only a notice in force can be ended.');
          assertUpdated(result, current);
        }
        if (b.tellResidents)
          await enqueueOutbox(
            trx,
            found.tenant_id,
            'health_notice.send',
            { noticeId: found.id, phase: 'ended' },
            request.executionId ?? null,
          );
        const r = (await one(trx, found.id))!;
        await request.audit(trx, {
          action: 'health_notice.approve',
          targetType: 'health_notice',
          targetId: r.id,
          targetVersion: r.version,
          ...(confirmation.reason ? { reason: confirmation.reason } : {}),
          changes: {
            fields: [
              { name: 'status', from: 'active', to: 'ended' },
              { name: 'end_reason', to: b.reason },
              { name: 'tell_residents', to: b.tellResidents },
            ],
          },
        });
        return toNotice(r);
      });
    },
  );
};
