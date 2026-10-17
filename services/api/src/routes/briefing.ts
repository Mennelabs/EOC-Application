/**
 * The wall briefing (CON-11; layer-8 plan §5): one aggregate payload per
 * event for the EOC wall display. Counts, place names and the event log
 * only: no resident, no address of a home, no staff contact detail. A
 * display account holding only `briefing.read` (template
 * `briefing_display`) reads it, so a shared screen never carries a staff
 * member's session (plan §13 question 4). The refresh interval is the
 * county's `briefing.refresh_seconds` (default 60).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { errors } from '../errors.ts';
import { configValue } from '../public/submit.ts';
import { iso } from './helpers.ts';

const counts = z.record(z.string(), z.number().int());
export const briefingOut = z.object({
  asOf: z.iso.datetime(),
  refreshSeconds: z.number().int(),
  event: z.object({
    id: z.uuid(),
    name: z.string(),
    hazardType: z.string(),
    status: z.string(),
    openedAt: z.iso.datetime().nullable(),
  }),
  /** Homes with verified damage by FEMA degree, and reports still waiting for review. */
  damage: z.object({
    byDegree: counts,
    verified: z.number().int(),
    awaitingReview: z.number().int(),
  }),
  shelters: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      capacity: z.number().int().nullable(),
      occupancy: z.number().int().nullable(),
    }),
  ),
  needs: z.object({ open: z.number().int(), byCategory: counts }),
  missions: z.object({ byState: counts }),
  resourceRequests: z.object({ byStatus: counts }),
  objectives: z.array(
    z.object({
      position: z.number().int(),
      objective: z.string(),
      owner: z.string().nullable(),
      status: z.string(),
    }),
  ),
  /** The last hours of the event log: what happened, when; never who a resident is. */
  significantEvents: z.array(
    z.object({ occurredAt: z.iso.datetime(), kind: z.string(), summary: z.string() }),
  ),
  /** CON-14 (layer-8 task D): live conditions with their source and age; empty until built. */
  liveConditions: z.array(
    z.object({
      kind: z.string(),
      summary: z.string(),
      source: z.string(),
      asOf: z.iso.datetime(),
    }),
  ),
});

export const briefingRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const tally = (rows: { k: string | null; n: string | number }[]) =>
    Object.fromEntries(rows.map((r) => [r.k ?? 'unknown', Number(r.n)]));

  app.get(
    '/briefing',
    {
      schema: {
        tags: ['briefing'],
        querystring: z.object({ eventId: z.uuid() }),
        response: { 200: briefingOut },
      },
    },
    async (request) => {
      const s = account(request);
      const { eventId } = request.query;
      await request.authorize(
        'briefing.read',
        { type: 'briefing', tenantId: s.tenantId, eventId },
        { asNotFound: true },
      );
      return request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select(['id', 'name', 'hazard_type', 'status', 'opened_at'])
          .where('id', '=', eventId)
          .where('tenant_id', '=', s.tenantId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        const since = new Date(Date.now() - 6 * 3_600_000);
        const now = new Date();
        const [
          refresh,
          degrees,
          awaiting,
          shelters,
          needStatus,
          needCategory,
          missions,
          requests,
          objectives,
          log,
        ] = await Promise.all([
          configValue<number | string>(trx, 'briefing.refresh_seconds'),
          trx
            .selectFrom('cg.report')
            .select([sql<string>`fema_degree`.as('k'), sql<string>`count(*)`.as('n')])
            .where('event_id', '=', eventId)
            .where('fema_degree', 'is not', null)
            .where('review_state', '=', 'approved')
            .groupBy('fema_degree')
            .execute(),
          trx
            .selectFrom('cg.report')
            .select(sql<string>`count(*)`.as('n'))
            .where('event_id', '=', eventId)
            .where('review_state', 'in', ['submitted', 'under_review'])
            .executeTakeFirstOrThrow(),
          trx
            .selectFrom('cg.site')
            .select(['name', 'status', 'capacity', 'occupancy'])
            .where('tenant_id', '=', s.tenantId)
            .where('event_id', '=', eventId)
            .where('kind', '=', 'shelter')
            .where('status', 'in', ['open', 'limited', 'full'])
            .orderBy('name')
            .limit(40)
            .execute(),
          trx
            .selectFrom('cg.need')
            .select([sql<string>`status`.as('k'), sql<string>`count(*)`.as('n')])
            .where('event_id', '=', eventId)
            .groupBy('status')
            .execute(),
          trx
            .selectFrom('cg.need')
            .select([sql<string>`category`.as('k'), sql<string>`count(*)`.as('n')])
            .where('event_id', '=', eventId)
            .where('status', 'in', ['open', 'claimed', 'in_progress'])
            .groupBy('category')
            .execute(),
          trx
            .selectFrom('cg.mission')
            .select([sql<string>`state`.as('k'), sql<string>`count(*)`.as('n')])
            .where('event_id', '=', eventId)
            .groupBy('state')
            .execute(),
          trx
            .selectFrom('cg.resource_request')
            .select([sql<string>`status`.as('k'), sql<string>`count(*)`.as('n')])
            .where('event_id', '=', eventId)
            .groupBy('status')
            .execute(),
          trx
            .selectFrom('cg.incident_objective')
            .select(['position', 'objective', 'owner_position', 'status'])
            .where('event_id', '=', eventId)
            .where('period_from', '<=', now)
            .where('period_to', '>', now)
            .orderBy('position')
            .limit(20)
            .execute(),
          trx
            .selectFrom('cg.significant_event')
            .select(['occurred_at', 'kind', 'summary'])
            .where('event_id', '=', eventId)
            .where('occurred_at', '>=', since)
            .orderBy('occurred_at', 'desc')
            .limit(12)
            .execute(),
        ]);
        const needs = tally(needStatus);
        const refreshSeconds = Math.min(Math.max(Number(refresh ?? 60) || 60, 15), 3600);
        return {
          asOf: now.toISOString(),
          refreshSeconds,
          event: {
            id: event.id,
            name: event.name,
            hazardType: event.hazard_type,
            status: event.status,
            openedAt: iso(event.opened_at),
          },
          damage: {
            byDegree: tally(degrees),
            verified: degrees.reduce((a, r) => a + Number(r.n), 0),
            awaitingReview: Number(awaiting.n),
          },
          shelters: shelters.map((x) => ({
            name: x.name,
            status: x.status,
            capacity: x.capacity,
            occupancy: x.occupancy,
          })),
          needs: {
            open: (needs['open'] ?? 0) + (needs['claimed'] ?? 0) + (needs['in_progress'] ?? 0),
            byCategory: tally(needCategory),
          },
          missions: { byState: tally(missions) },
          resourceRequests: { byStatus: tally(requests) },
          objectives: objectives.map((o) => ({
            position: o.position,
            objective: o.objective,
            owner: o.owner_position,
            status: o.status,
          })),
          significantEvents: log.map((e) => ({
            occurredAt: iso(e.occurred_at)!,
            kind: e.kind,
            summary: e.summary,
          })),
          liveConditions: [],
        };
      });
    },
  );
};
