/**
 * Recommendations (layer-7 task E; REC-02–REC-12): shelters, feeding stops
 * for the canteens on the roster, a POD with walk-up points, and a MARC. The
 * engine in `@cg/reporting` answers from rules and the registry, never from a
 * language model; the answer is stored as it was shown, with the weights and
 * planning factors in force (the tenant's, or the documented defaults). A
 * named person accepts it, edits it (another place; for feeding, stops
 * swapped), or rejects it, always with a reason; the decision is logged and
 * audited (REC-04). Nothing here changes a site, a facility or a team.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, RecommendationTable } from '@cg/db';
import {
  MARC_WEIGHTS,
  PLANNING_DEFAULTS,
  POD_WEIGHTS,
  SHELTER_WEIGHTS,
  loadFeedingInputs,
  loadMarcInputs,
  loadPodInputs,
  loadShelterInputs,
  recommendFeeding,
  recommendMarc,
  recommendPod,
  recommendShelter,
  type PlanningFactors,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Row = Selectable<RecommendationTable>;

const KINDS = ['shelter', 'feeding', 'pod', 'marc'] as const;
type Kind = (typeof KINDS)[number];
const WEIGHTS = { shelter: SHELTER_WEIGHTS, pod: POD_WEIGHTS, marc: MARC_WEIGHTS } as const;

const swapIn = z
  .object({
    stop: z.number().int().min(1),
    /** A place in the registry, or one the partner knows, described. */
    facilityId: z.uuid().optional(),
    place: z.string().trim().min(3).max(200).optional(),
  })
  .refine((x) => !!x.facilityId !== !!x.place, 'name a registered place or describe one');

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
  decisionChanges: z.array(z.record(z.string(), z.unknown())).nullable(),
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
  decisionChanges: r.decision_changes,
});

/** Tenant values win where they are sensible numbers; anything else falls back to the default. */
function merged<T extends object>(defaults: T, raw: unknown, min = 0): T {
  const out = { ...defaults } as Record<string, number>;
  if (raw && typeof raw === 'object')
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (k in out && typeof v === 'number' && Number.isFinite(v) && v >= min) out[k] = v;
  return out as T;
}

async function settingsOf(trx: Transaction<Database>, tenantId: string, kind: Kind) {
  const keys = ['recommendation.planning_factors', `recommendation.weights.${kind}`];
  const rows = await trx
    .selectFrom('cg.tenant_config')
    .select(['key', 'value'])
    .where('tenant_id', '=', tenantId)
    .where('key', 'in', keys)
    .execute();
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    factors: merged<PlanningFactors>(PLANNING_DEFAULTS, get(keys[0]!), 0.01),
    weights: kind === 'feeding' ? null : merged(WEIGHTS[kind], get(keys[1]!)),
  };
}

/** Runs the rules for one kind on the event's data, in the caller's transaction. */
async function compute(
  trx: Transaction<Database>,
  tenantId: string,
  eventId: string,
  kind: Kind,
  teamIds: string[] | undefined,
): Promise<{ result: Record<string, unknown>; summary: string }> {
  const now = new Date();
  const { factors, weights } = await settingsOf(trx, tenantId, kind);
  switch (kind) {
    case 'shelter': {
      const i = await loadShelterInputs(trx, tenantId, eventId, now, factors);
      const r = recommendShelter(i.candidates, i.demand, i.tracts, i.inputs, factors, {
        ...SHELTER_WEIGHTS,
        ...weights,
      });
      return {
        result: { ...r },
        summary: `${r.top.length} ranked, ${r.excluded.length} set aside`,
      };
    }
    case 'feeding': {
      const i = await loadFeedingInputs(trx, tenantId, eventId, now, factors, teamIds);
      const r = recommendFeeding(i.candidates, i.cells, i.canteens, i.tracts, i.inputs, factors);
      return {
        result: { ...r },
        summary: `${r.stops.length} stops for ${r.canteens.length} canteens, ${r.unserved} households beyond them`,
      };
    }
    case 'pod': {
      const i = await loadPodInputs(trx, tenantId, eventId, now, factors);
      const r = recommendPod(i.candidates, i.demand, i.tracts, i.inputs, factors, {
        ...POD_WEIGHTS,
        ...weights,
      });
      return {
        result: { ...r },
        summary: r.pod
          ? `Type ${r.pod.type} x${r.pod.count}, ${r.walkUps.length} walk-up points`
          : 'no POD needed',
      };
    }
    case 'marc': {
      const i = await loadMarcInputs(trx, tenantId, eventId, now, factors);
      const r = recommendMarc(i.candidates, i.demand, i.tracts, i.inputs, factors, {
        ...MARC_WEIGHTS,
        ...weights,
      });
      return {
        result: { ...r },
        summary: `${r.services.length} services, ${r.tables} tables, ${r.top.length} sites ranked`,
      };
    }
  }
}

export const recommendationRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  // ADM-01: the planning factors in force, for the county's editor. Changes are saved through
  // the audited configuration route (recommendation.planning_factors), with a reason.
  app.get(
    '/recommendations/planning-factors',
    {
      schema: {
        tags: ['recommendations'],
        response: {
          200: z.object({
            defaults: z.record(z.string(), z.number()),
            overrides: z.record(z.string(), z.number()),
            inForce: z.record(z.string(), z.number()),
            version: z.number().int().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('tenant.config.read', {
        type: 'tenant_config',
        tenantId: s.tenantId,
      });
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.tenant_config')
          .select(['value', 'version'])
          .where('tenant_id', '=', s.tenantId)
          .where('key', '=', 'recommendation.planning_factors')
          .executeTakeFirst(),
      );
      const inForce = merged<PlanningFactors>(PLANNING_DEFAULTS, row?.value, 0.01);
      const defaults = PLANNING_DEFAULTS as unknown as Record<string, number>;
      const overrides = Object.fromEntries(
        Object.entries(inForce as unknown as Record<string, number>).filter(
          ([k, v]) => v !== defaults[k],
        ),
      );
      return {
        defaults,
        overrides,
        inForce: inForce as unknown as Record<string, number>,
        version: row?.version ?? null,
      };
    },
  );

  app.post(
    '/recommendations',
    {
      config: { idempotent: true },
      schema: {
        tags: ['recommendations'],
        body: z.object({
          kind: z.enum(KINDS),
          eventId: z.uuid(),
          /** Feeding: plan for these canteens only; default, every active canteen on the roster. */
          teamIds: z.array(z.uuid()).min(1).max(20).optional(),
        }),
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
        const { result, summary } = await compute(trx, s.tenantId, b.eventId, b.kind, b.teamIds);
        const inserted = await trx
          .insertInto('cg.recommendation')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            kind: b.kind,
            engine_version: String(result['engineVersion']),
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
          reason: `${b.kind}: ${summary}`,
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
          kind: z.enum(KINDS).optional(),
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
        body: z.object({
          decision: z.enum(['accept', 'edit', 'reject']),
          /**
           * Shelter, POD, MARC: accept takes the top pick unless another of
           * those shown is named; edit names any approved facility instead.
           */
          facilityId: z.uuid().optional(),
          /** Feeding: an edit swaps stops for other places (docs/02: a church lot the team knows). */
          swaps: z.array(swapIn).min(1).max(20).optional(),
          note: z.string().trim().max(1000).optional(),
          reason: z.string().trim().min(3).max(500),
        }),
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
          const approved = async (id: string) =>
            trx
              .selectFrom('cg.facility')
              .select(['id', 'name'])
              .where('id', '=', id)
              .where('status', '=', 'approved')
              .executeTakeFirst();
          let chosen: string | null = null;
          let changes: Record<string, unknown>[] | null = null;
          if (current.kind === 'feeding') {
            if (b.facilityId)
              throw errors.validation([
                { name: 'facilityId', message: 'feeding is edited stop by stop: use swaps' },
              ]);
            if (b.decision !== 'edit' && b.swaps)
              throw errors.validation([{ name: 'swaps', message: 'only an edit swaps stops' }]);
            if (b.decision === 'edit') {
              if (!b.swaps)
                throw errors.validation([{ name: 'swaps', message: 'name the stops swapped' }]);
              const stops = (current.result['stops'] as { stop: number; place: string }[]) ?? [];
              changes = [];
              for (const w of b.swaps) {
                const was = stops.find((x) => x.stop === w.stop);
                if (!was)
                  throw errors.validation([{ name: 'swaps', message: `no stop ${w.stop}` }]);
                const f = w.facilityId ? await approved(w.facilityId) : null;
                if (w.facilityId && !f)
                  throw errors.validation([{ name: 'swaps', message: 'not in the registry' }]);
                changes.push({
                  stop: w.stop,
                  from: was.place,
                  to: f ? f.name : w.place,
                  facilityId: f?.id ?? null,
                });
              }
            }
          } else {
            if (b.swaps)
              throw errors.validation([{ name: 'swaps', message: 'only feeding has stops' }]);
            const top = ((current.result['top'] as { facilityId: string }[] | undefined) ?? []).map(
              (t) => t.facilityId,
            );
            if (b.decision === 'accept') {
              chosen = b.facilityId ?? top[0] ?? null;
              if (!chosen || !top.includes(chosen))
                throw errors.validation([
                  { name: 'facilityId', message: 'accept one of the places recommended, or edit' },
                ]);
            } else if (b.decision === 'edit') {
              const f = b.facilityId ? await approved(b.facilityId) : null;
              if (!f)
                throw errors.validation([
                  {
                    name: 'facilityId',
                    message: 'name the place chosen instead from the registry',
                  },
                ]);
              chosen = f.id;
              changes = [{ to: f.name, facilityId: f.id }];
            }
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
              decision_changes: changes ? JSON.stringify(changes) : null,
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
                ...(changes
                  ? [{ name: 'decision_changes', to: `${changes.length} change(s)` }]
                  : []),
              ],
            },
          });
          return decided;
        }),
      );
    },
  );
};
