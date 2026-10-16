/**
 * Events (SCL-02): open from a template, publish the intake link and keyword,
 * invite partner tenants, close with a reason. Missions (layer 4) and reports
 * (layer 2) hang off these.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { diffForAudit } from '@cg/audit';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import {
  classifierFor,
  enqueueOutbox,
  iso,
  listQuery,
  pickDefined,
  stamped,
  uuidParam,
} from './helpers.ts';

const eventOut = z.object({
  ...stamped,
  tenantId: z.uuid(),
  templateId: z.uuid().nullable(),
  name: z.string(),
  hazardType: z.string(),
  status: z.enum(['draft', 'active', 'closed']),
  intakeSlug: z.string().nullable(),
  intakeKeywords: z.array(z.string()),
  /** FLD-03: the staging code people scan (as a QR code) or type to check in. */
  checkInCode: z.string().nullable(),
  openedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closeReason: z.string().nullable(),
});

type EventRow = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  tenant_id: string;
  template_id: string | null;
  name: string;
  hazard_type: string;
  status: 'draft' | 'active' | 'closed';
  intake_slug: string | null;
  intake_keywords: string[];
  check_in_code: string | null;
  opened_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
};

const toEvent = (r: EventRow): z.infer<typeof eventOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  tenantId: r.tenant_id,
  templateId: r.template_id,
  name: r.name,
  hazardType: r.hazard_type,
  status: r.status,
  intakeSlug: r.intake_slug,
  intakeKeywords: r.intake_keywords,
  checkInCode: r.check_in_code,
  openedAt: iso(r.opened_at),
  closedAt: iso(r.closed_at),
  closeReason: r.close_reason,
});

const slug = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');

/** FLD-03: letters and digits that cannot be mistaken for one another (no 0/O, 1/I/L, 2/Z, 5/S, 8/B, 6/G). */
const CODE_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';

/** A new six-character staging code, read off a sign or a phone without confusion. */
export function newCheckInCode(): string {
  return Array.from(randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** SMS keywords are single words, upper-cased, letters only (docs/06). */
const keyword = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[A-ZÁÉÍÓÚÑ]+$/, 'one word, capital letters');

export const eventRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  async function load(
    request: {
      tx: <T>(
        fn: (trx: import('kysely').Transaction<import('@cg/db').Database>) => Promise<T>,
      ) => Promise<T>;
    },
    id: string,
  ) {
    const row = await request.tx((trx) =>
      trx.selectFrom('cg.event').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!row) throw errors.notFound();
    return row;
  }

  app.get(
    '/events',
    { schema: { tags: ['events'], querystring: listQuery, response: { 200: z.array(eventOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('event.read', { type: 'event', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.event')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map(toEvent);
    },
  );

  app.get(
    '/events/:id',
    { schema: { tags: ['events'], params: uuidParam, response: { 200: eventOut } } },
    async (request) => {
      const row = await load(request, request.params.id);
      await request.authorize(
        'event.read',
        { type: 'event', id: row.id, tenantId: row.tenant_id, eventId: row.id },
        { asNotFound: true },
      );
      return toEvent(row);
    },
  );

  /** CHN-08, CON-02: everything a flyer or a kiosk needs for this event. */
  app.get(
    '/events/:id/intake',
    {
      schema: {
        tags: ['events'],
        params: uuidParam,
        response: {
          200: z.object({
            slug: z.string().nullable(),
            keywords: z.array(z.string()),
            url: z.string().nullable(),
            kioskUrl: z.string().nullable(),
            smsNumber: z.string().nullable(),
            graph: z.object({ key: z.string(), version: z.number().int() }).nullable(),
          }),
        },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const row = await load(request, request.params.id);
      await request.authorize(
        'event.read',
        { type: 'event', id: row.id, tenantId: row.tenant_id, eventId: row.id },
        { asNotFound: true },
      );
      return request.tx(async (trx) => {
        const tenant = await trx
          .selectFrom('cg.tenant')
          .select('slug')
          .where('id', '=', row.tenant_id)
          .executeTakeFirstOrThrow();
        const number = await trx
          .selectFrom('cg.channel_number')
          .select('number')
          .where('tenant_id', '=', row.tenant_id)
          .orderBy('created_at')
          .executeTakeFirst();
        const graph = await trx
          .selectFrom('cg.intake_graph')
          .select(['key', 'graph_version'])
          .where('status', '=', 'published')
          .orderBy('published_at', 'desc')
          .executeTakeFirst();
        const base = `${request.protocol}://${request.hostname}`;
        return {
          slug: row.intake_slug,
          keywords: row.intake_keywords,
          url: row.intake_slug ? `${base}/${tenant.slug}/${row.intake_slug}` : null,
          kioskUrl: row.intake_slug ? `${base}/${tenant.slug}/${row.intake_slug}/kiosk` : null,
          smsNumber: number?.number ?? null,
          graph: graph ? { key: graph.key, version: graph.graph_version } : null,
        };
      });
    },
  );

  app.post(
    '/events',
    {
      config: { idempotent: true },
      schema: {
        tags: ['events'],
        body: z.object({
          name: z.string().min(1).max(200),
          hazardType: z.string().min(1).max(60),
          templateId: z.uuid().optional(),
        }),
        response: { 201: eventOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('event.create', { type: 'event', tenantId: s.tenantId });
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.event')
          .values({
            tenant_id: s.tenantId,
            template_id: request.body.templateId ?? null,
            name: request.body.name,
            hazard_type: request.body.hazardType,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'event.create',
          targetType: 'event',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            { name: inserted.name, hazard_type: inserted.hazard_type },
            classifierFor('event'),
          ),
        });
        return inserted;
      });
      return reply.code(201).send(toEvent(row));
    },
  );

  app.patch(
    '/events/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['events'],
        params: uuidParam,
        body: z.object({
          name: z.string().min(1).max(200).optional(),
          hazardType: z.string().min(1).max(60).optional(),
        }),
        response: { 200: eventOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await load(request, request.params.id);
      await request.authorize(
        'event.update',
        { type: 'event', id: current.id, tenantId: current.tenant_id, eventId: current.id },
        { asNotFound: true },
      );
      if (current.status === 'closed') throw errors.conflict(toEvent(current));
      const changes = pickDefined(request.body, { name: 'name', hazardType: 'hazard_type' });
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.event')
            .set({ ...changes, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toEvent(current),
        );
        await request.audit(trx, {
          action: 'event.update',
          targetType: 'event',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(current, row, classifierFor('event')),
        });
        return row;
      });
      return toEvent(updated);
    },
  );

  /**
   * FLD-03: set or replace the event's staging check-in code. Without a code a new
   * one is made; a replaced code stops working at once, so a printed sign that
   * leaked can be retired. Codes are unique within the county.
   */
  app.post(
    '/events/:id/check-in-code',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['events'],
        params: uuidParam,
        body: z.object({
          code: z
            .string()
            .trim()
            .min(4)
            .max(12)
            .regex(/^[A-Za-z0-9]+$/, 'letters and digits only')
            .optional(),
        }),
        response: { 200: eventOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await load(request, request.params.id);
      await request.authorize(
        'event.check_in_code',
        { type: 'event', id: current.id, tenantId: current.tenant_id, eventId: current.id },
        { asNotFound: true },
      );
      if (current.status === 'closed') throw errors.conflict(toEvent(current));
      const code = (request.body.code ?? newCheckInCode()).toUpperCase();
      const updated = await request.tx(async (trx) => {
        const taken = await trx
          .selectFrom('cg.event')
          .select('id')
          .where(sql`upper(check_in_code)`, '=', code)
          .where('id', '<>', current.id)
          .executeTakeFirst();
        if (taken)
          throw errors.validation([{ name: 'code', message: 'another event uses this code' }]);
        const row = assertUpdated(
          await trx
            .updateTable('cg.event')
            .set({ check_in_code: code, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toEvent(current),
        );
        await request.audit(trx, {
          action: 'event.check_in_code',
          targetType: 'event',
          targetId: row.id,
          targetVersion: row.version,
          changes: {
            fields: [{ name: 'check_in_code', to: current.check_in_code ? 'replaced' : 'set' }],
          },
        });
        return row;
      });
      return toEvent(updated);
    },
  );

  app.post(
    '/events/:id/open',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['events'],
        params: uuidParam,
        body: z.object({ intakeSlug: slug, intakeKeywords: z.array(keyword).min(1).max(6) }),
        response: { 200: eventOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await load(request, request.params.id);
      await request.authorize(
        'event.open',
        { type: 'event', id: current.id, tenantId: current.tenant_id, eventId: current.id },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      if (current.status !== 'draft') throw errors.conflict(toEvent(current));
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.event')
            .set({
              status: 'active',
              opened_at: new Date(),
              intake_slug: request.body.intakeSlug,
              intake_keywords: request.body.intakeKeywords,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toEvent(current),
        );
        await request.audit(trx, {
          action: 'event.open',
          targetType: 'event',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(current, row, classifierFor('event')),
          reason,
        });
        await enqueueOutbox(
          trx,
          s.tenantId,
          'event.opened',
          { eventId: row.id },
          request.executionId,
        );
        return row;
      });
      return toEvent(updated);
    },
  );

  app.post(
    '/events/:id/close',
    {
      config: { requiresVersion: true },
      schema: { tags: ['events'], params: uuidParam, response: { 200: eventOut } },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await load(request, request.params.id);
      await request.authorize(
        'event.close',
        { type: 'event', id: current.id, tenantId: current.tenant_id, eventId: current.id },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      if (current.status !== 'active') throw errors.conflict(toEvent(current));
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.event')
            .set({
              status: 'closed',
              closed_at: new Date(),
              close_reason: reason,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toEvent(current),
        );
        await request.audit(trx, {
          action: 'event.close',
          targetType: 'event',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(current, row, classifierFor('event')),
          reason,
        });
        return row;
      });
      return toEvent(updated);
    },
  );

  app.post(
    '/events/:id/participants',
    {
      config: { idempotent: true },
      schema: {
        tags: ['events'],
        params: uuidParam,
        body: z.object({ tenantId: z.uuid(), role: z.string().min(1).max(40).default('partner') }),
        response: { 201: z.object({ eventId: z.uuid(), tenantId: z.uuid(), role: z.string() }) },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const current = await load(request, request.params.id);
      await request.authorize(
        'event.participant.add',
        { type: 'event', id: current.id, tenantId: current.tenant_id, eventId: current.id },
        { asNotFound: true },
      );
      if (current.tenant_id !== s.tenantId) throw errors.notFound();
      await request.tx(async (trx) => {
        // The participant row belongs to the invited tenant; RLS lets the
        // owner insert it only through the system role, so it goes via the
        // outbox and the worker applies it (ADR-0007). Record the intent now.
        await request.audit(trx, {
          action: 'event.participant.add',
          targetType: 'event',
          targetId: current.id,
          changes: { fields: [{ name: 'participant', to: request.body.tenantId }] },
        });
        await enqueueOutbox(
          trx,
          s.tenantId,
          'event.participant.add',
          {
            eventId: current.id,
            tenantId: request.body.tenantId,
            role: request.body.role,
            addedBy: s.accountId,
          },
          request.executionId,
        );
      });
      return reply
        .code(201)
        .send({ eventId: current.id, tenantId: request.body.tenantId, role: request.body.role });
    },
  );
};
