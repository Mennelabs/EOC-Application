/**
 * Recommendations (layer-7 task E; REC-02, REC-03, REC-04, REC-10, REC-11,
 * REC-12). The engine in `@cg/reporting` answers from rules and the
 * registry, never from a language model; the answer is stored as it was
 * shown, with the weights and planning factors in force (the tenant's, or
 * the documented defaults). A named person accepts the top pick, picks
 * another place (edit), or rejects it, always with a reason; the decision is
 * logged and audited (REC-04). Nothing here changes a site or a facility.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, RecommendationTable } from '@cg/db';
import {
  PLANNING_DEFAULTS,
  SHELTER_WEIGHTS,
  loadShelterInputs,
  recommendShelter,
  type PlanningFactors,
  type ShelterWeights,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Row = Selectable<RecommendationTable>;

const recommendationOut = z.object({
  ...stamped,
  eventId: z.uuid(),
  kind: z.string(),
  engineVersion: z.string(),
  result: z.record(z.string(), z.unknown()),
  requestedBy: z.uuid().nullable(),
  state: z.enum(['open', 'accepted', 'edited', 'rejected']),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  chosenFacilityId: z.uuid().nullable(),
  decisionNote: z.string().nullable(),
});

const toOut = (r: Row): z.infer<typeof recommendationOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  eventId: r.event_id,
  kind: r.kind,
  engineVersion: r.engine_version,
  result: r.result,
  requestedBy: r.requested_by,
  state: r.state,
  decidedBy: r.decided_by,
  decidedAt: iso(r.decided_at),
  decisionReason: r.decision_reason,
  chosenFacilityId: r.chosen_facility_id,
  decisionNote: r.decision_note,
});

/** Tenant values win where they are sensible numbers; anything else falls back to the default. */
function merged<T extends object>(defaults: T, raw: unknown, min = 0): T {
  const out = { ...defaults } as Record<string, number>;
  if (raw && typeof raw === 'object')
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (k in out && typeof v === 'number' && Number.isFinite(v) && v >= min) out[k] = v;
  return out as T;
}

async function settingsOf(trx: Transaction<Database>, tenantId: string) {
  const rows = await trx
    .selectFrom('cg.tenant_config')
    .select(['key', 'value'])
    .where('tenant_id', '=', tenantId)
    .where('key', 'in', ['recommendation.planning_factors', 'recommendation.weights.shelter'])
    .execute();
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    factors: merged<PlanningFactors>(
      PLANNING_DEFAULTS,
      get('recommendation.planning_factors'),
      0.01,
    ),
    weights: merged<ShelterWeights>(SHELTER_WEIGHTS, get('recommendation.weights.shelter')),
  };
}

export const recommendationRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.post(
    '/recommendations',
    {
      config: { idempotent: true },
      schema: {
        tags: ['recommendations'],
        body: z.object({ kind: z.literal('shelter'), eventId: z.uuid() }),
        response: { 201: recommendationOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('recommendation.request', {
        type: 'recommendation',
        tenantId: s.tenantId,
        eventId: b.eventId,
      });
      const row = await request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select('id')
          .where('id', '=', b.eventId)
          .where('tenant_id', '=', s.tenantId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        const now = new Date();
        const { factors, weights } = await settingsOf(trx, s.tenantId);
        const inputs = await loadShelterInputs(trx, s.tenantId, b.eventId, now, factors);
        const result = recommendShelter(
          inputs.candidates,
          inputs.demand,
          inputs.tracts,
          inputs.inputs,
          factors,
          weights,
        );
        const inserted = await trx
          .insertInto('cg.recommendation')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            kind: b.kind,
            engine_version: result.engineVersion,
            result: JSON.stringify(result),
            requested_by: s.accountId,
            execution_id: request.executionId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'recommendation.request',
          targetType: 'recommendation',
          targetId: inserted.id,
          targetVersion: inserted.version,
          reason: `${b.kind}: ${result.top.length} ranked, ${result.excluded.length} set aside`,
        });
        return inserted;
      });
      return reply.code(201).send(toOut(row));
    },
  );

  app.get(
    '/recommendations',
    {
      schema: {
        tags: ['recommendations'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          kind: z.enum(['shelter', 'feeding', 'pod', 'walkup', 'marc']).optional(),
        }),
        response: { 200: z.array(recommendationOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('recommendation.request', {
        type: 'recommendation',
        tenantId: s.tenantId,
      });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.recommendation')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.kind) x = x.where('kind', '=', q.kind);
        return x.execute();
      });
      return rows.map(toOut);
    },
  );

  app.get(
    '/recommendations/:id',
    {
      schema: {
        tags: ['recommendations'],
        params: uuidParam,
        response: { 200: recommendationOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('recommendation.request', {
        type: 'recommendation',
        tenantId: s.tenantId,
      });
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.recommendation')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      return toOut(row);
    },
  );

  app.post(
    '/recommendations/:id/decision',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['recommendations'],
        params: uuidParam,
        body: z
          .object({
            decision: z.enum(['accept', 'edit', 'reject']),
            /** accept: the top pick unless another of the three is named; edit: any approved facility. */
            facilityId: z.uuid().optional(),
            note: z.string().trim().max(1000).optional(),
            reason: z.string().trim().min(3).max(500),
          })
          .refine((b) => b.decision !== 'edit' || b.facilityId, 'name the place chosen instead'),
        response: { 200: recommendationOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('recommendation.decide', {
        type: 'recommendation',
        tenantId: s.tenantId,
      });
      const b = request.body;
      return toOut(
        await request.tx(async (trx) => {
          const current = await trx
            .selectFrom('cg.recommendation')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!current) throw errors.notFound();
          if (current.version !== request.expectedVersion()) throw errors.conflict(toOut(current));
          if (current.state !== 'open')
            throw new ApiError(409, 'already_decided', 'This recommendation was already decided.');
          const top = ((current.result['top'] as { facilityId: string }[] | undefined) ?? []).map(
            (t) => t.facilityId,
          );
          let chosen: string | null = null;
          if (b.decision === 'accept') {
            chosen = b.facilityId ?? top[0] ?? null;
            if (!chosen || !top.includes(chosen))
              throw errors.validation([
                { name: 'facilityId', message: 'accept one of the places recommended, or edit' },
              ]);
          } else if (b.decision === 'edit') {
            const f = await trx
              .selectFrom('cg.facility')
              .select('id')
              .where('id', '=', b.facilityId!)
              .where('status', '=', 'approved')
              .executeTakeFirst();
            if (!f)
              throw errors.validation([{ name: 'facilityId', message: 'not in the registry' }]);
            chosen = f.id;
          }
          const decided = await trx
            .updateTable('cg.recommendation')
            .set({
              state:
                b.decision === 'accept'
                  ? 'accepted'
                  : b.decision === 'edit'
                    ? 'edited'
                    : 'rejected',
              decided_by: s.accountId,
              decided_at: new Date(),
              decision_reason: b.reason,
              chosen_facility_id: chosen,
              decision_note: b.note ?? null,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: `recommendation.${b.decision}`,
            targetType: 'recommendation',
            targetId: decided.id,
            targetVersion: decided.version,
            reason: b.reason,
            changes: {
              fields: [
                { name: 'state', from: current.state, to: decided.state },
                { name: 'chosen_facility_id', to: chosen },
              ],
            },
          });
          return decided;
        }),
      );
    },
  );
};
