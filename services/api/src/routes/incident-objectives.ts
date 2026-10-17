/**
 * Incident objectives (CON-13; the ICS 202 blocks; layer-8 plan §4): planning
 * writes the objectives of an operational period, each with the position
 * that owns it; they feed the ICS 201 briefing (block 7) and the wall
 * display. Versioned and audited (FR-00.*). Objectives name positions, never
 * residents.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, stamped, uuidParam } from './helpers.ts';

type Row = Selectable<Database['cg.incident_objective']>;

const STATUSES = ['open', 'met', 'dropped'] as const;
const objectiveOut = z.object({
  ...stamped,
  eventId: z.uuid(),
  periodFrom: z.iso.datetime(),
  periodTo: z.iso.datetime(),
  position: z.number().int(),
  objective: z.string(),
  ownerPosition: z.string().nullable(),
  status: z.enum(STATUSES),
  note: z.string().nullable(),
});
const view = (r: Row): z.infer<typeof objectiveOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  eventId: r.event_id,
  periodFrom: iso(r.period_from)!,
  periodTo: iso(r.period_to)!,
  position: r.position,
  objective: r.objective,
  ownerPosition: r.owner_position,
  status: r.status,
  note: r.note,
});

export const incidentObjectiveRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.get(
    '/incident-objectives',
    {
      schema: {
        tags: ['ics forms'],
        querystring: z.object({
          eventId: z.uuid(),
          /** The period that contains this instant; the latest period when absent. */
          at: z.iso.datetime().optional(),
        }),
        response: { 200: z.array(objectiveOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const q = request.query;
      await request.authorize('incident_objective.read', {
        type: 'incident_objective',
        tenantId: s.tenantId,
        eventId: q.eventId,
      });
      return request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.incident_objective')
          .selectAll()
          .where('tenant_id', '=', s.tenantId)
          .where('event_id', '=', q.eventId);
        if (q.at) {
          const at = new Date(q.at);
          x = x.where('period_from', '<=', at).where('period_to', '>', at);
        }
        const rows = await x.orderBy('period_from', 'desc').orderBy('position').execute();
        if (q.at || !rows.length) return rows.map(view);
        // Without an instant: the latest period only.
        const latest = rows[0]!.period_from.getTime();
        return rows.filter((r) => r.period_from.getTime() === latest).map(view);
      });
    },
  );

  app.post(
    '/incident-objectives',
    {
      schema: {
        tags: ['ics forms'],
        body: z.object({
          eventId: z.uuid(),
          periodFrom: z.iso.datetime(),
          periodTo: z.iso.datetime(),
          objective: z.string().trim().min(3).max(1000),
          ownerPosition: z.string().trim().max(120).optional(),
          note: z.string().trim().max(2000).optional(),
        }),
        response: { 201: objectiveOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('incident_objective.write', {
        type: 'incident_objective',
        tenantId: s.tenantId,
        eventId: b.eventId,
      });
      if (new Date(b.periodTo) <= new Date(b.periodFrom))
        throw errors.validation([{ name: 'periodTo', message: 'after the period start' }]);
      const out = await request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select(['id', 'status'])
          .where('id', '=', b.eventId)
          .where('tenant_id', '=', s.tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!event)
          throw errors.validation([{ name: 'eventId', message: 'an event of this organization' }]);
        if (event.status === 'closed')
          throw new ApiError(409, 'event_closed', 'This event is closed.');
        const last = await trx
          .selectFrom('cg.incident_objective')
          .select((eb) => eb.fn.max('position').as('n'))
          .where('event_id', '=', event.id)
          .where('period_from', '=', new Date(b.periodFrom))
          .executeTakeFirst();
        const r = await trx
          .insertInto('cg.incident_objective')
          .values({
            tenant_id: s.tenantId,
            event_id: event.id,
            period_from: new Date(b.periodFrom),
            period_to: new Date(b.periodTo),
            position: Number(last?.n ?? 0) + 1,
            objective: b.objective,
            owner_position: b.ownerPosition || null,
            note: b.note || null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'incident_objective.write',
          targetType: 'incident_objective',
          targetId: r.id,
          targetVersion: r.version,
          changes: { fields: [{ name: 'objective', to: r.objective }] },
        });
        return view(r);
      });
      return reply.code(201).send(out);
    },
  );

  app.patch(
    '/incident-objectives/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['ics forms'],
        params: uuidParam,
        body: z.object({
          objective: z.string().trim().min(3).max(1000).optional(),
          ownerPosition: z.string().trim().max(120).nullable().optional(),
          status: z.enum(STATUSES).optional(),
          note: z.string().trim().max(2000).nullable().optional(),
        }),
        response: { 200: objectiveOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await request.tx((trx) =>
        trx
          .selectFrom('cg.incident_objective')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!found || found.tenant_id !== s.tenantId) throw errors.notFound();
      await request.authorize(
        'incident_objective.write',
        {
          type: 'incident_objective',
          id: found.id,
          tenantId: found.tenant_id,
          eventId: found.event_id,
        },
        { asNotFound: true },
      );
      const expected = request.expectedVersion();
      const b = request.body;
      const set = {
        ...(b.objective !== undefined ? { objective: b.objective } : {}),
        ...(b.ownerPosition !== undefined ? { owner_position: b.ownerPosition || null } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(b.note !== undefined ? { note: b.note || null } : {}),
      };
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.incident_objective')
            .set({ ...set, updated_by: s.accountId })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await request.audit(trx, {
          action: 'incident_objective.write',
          targetType: 'incident_objective',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: Object.keys(set).map((name) => ({ name })) },
        });
        return view(updated);
      });
    },
  );
};
