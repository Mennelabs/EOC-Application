/**
 * Field-team routing from the review queue (CON-05: "review queue plus
 * field-team routing"). A reviewer sends a report to the field with the
 * `field_visit` review decision (routes/reports.ts); the report stays in
 * review until a team's visit verifies it (DCL:DEC-02/03) or a reviewer
 * decides it another way. Here the reports waiting for a visit are grouped by
 * the route area of their parcel, with any open route already covering them,
 * and a verification route can be opened for the ones not yet on a route:
 * its stops are their parcels, no-photo reports first, and the phone's sweep
 * walks those parcels only. Opening the route goes through the usual mission
 * step and the caller's own permission to open missions. A report with no
 * parcel in a route area is listed by ZIP code: a route needs parcels to walk.
 * Only reference codes, parcel ids and counts leave here, never the
 * resident's address or words, so reading reports is enough to see the
 * list; opening a route is a mission like any other and needs no more.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { stepKey } from './helpers.ts';

type Trx = Transaction<Database>;

interface Waiting {
  id: string;
  location_id: string;
  /** The parcel the location already names; null when it was found by its point or address. */
  named_parcel: string | null;
  reference_code: string;
  field_visit_requested_at: Date;
  photos: string;
  parcel_id: string | null;
  area_key: string | null;
  postal: string | null;
  lat: number | null;
  lon: number | null;
}

/**
 * Reports a reviewer sent to the field that no visit has verified yet, oldest request first.
 * Each finds its parcel by the one its location names, else the parcel under its point, else
 * the parcel of record at its street line (and ZIP or city when the parcel has them).
 */
const waitingReports = async (trx: Trx, eventId: string, areaKey?: string) =>
  (
    await sql<Waiting>`
      select r.id, l.id as location_id, l.parcel_id as named_parcel,
             r.reference_code, r.field_visit_requested_at,
             (select count(*) from cg.photo ph where ph.report_id = r.id) as photos,
             coalesce(p1.parcel_id, p2.parcel_id, p3.parcel_id) as parcel_id,
             coalesce(p1.area_key, p2.area_key, p3.area_key) as area_key,
             l.postal,
             ST_Y(coalesce(p1.centroid, p2.centroid, p3.centroid)) as lat,
             ST_X(coalesce(p1.centroid, p2.centroid, p3.centroid)) as lon
        from cg.report r
        join cg.location l on l.id = r.location_id
        left join cg.parcel p1 on p1.parcel_id = l.parcel_id
        left join lateral (
          select p.parcel_id, p.area_key, p.centroid from cg.parcel p
           where p1.id is null and l.geom is not null and ST_Intersects(p.geom, l.geom)
           limit 1
        ) p2 on true
        left join lateral (
          select p.parcel_id, p.area_key, p.centroid from cg.parcel p
           where p1.id is null and p2.parcel_id is null and l.line1 is not null
             and lower(p.line1) = lower(regexp_replace(trim(l.line1), '[[:space:]]+', ' ', 'g'))
             and (p.postal is null or l.postal is null or p.postal = l.postal)
             and (p.city is null or l.city is null or lower(p.city) = lower(trim(l.city)))
           limit 1
        ) p3 on true
       where r.event_id = ${eventId}
         and r.field_visit_requested_at is not null
         and r.withdrawn_at is null
         and r.verification_level <> 'field_verified'
         and r.review_state in ('submitted', 'under_review', 'needs_information')
         ${areaKey ? sql`and coalesce(p1.area_key, p2.area_key, p3.area_key) = ${areaKey}` : sql``}
       order by r.field_visit_requested_at
       limit 2000`.execute(trx)
  ).rows;

interface OpenRoute {
  id: string;
  reference: string;
  state: string;
  area: string | null;
  reports: string[];
}

/** Open verification routes in the event, with the area and the reports each covers. */
const openRoutes = async (trx: Trx, eventId: string): Promise<OpenRoute[]> =>
  (
    await trx
      .selectFrom('cg.mission')
      .select(['id', 'reference', 'state', 'route'])
      .where('event_id', '=', eventId)
      .where('kind', '=', 'verification_route')
      .where('state', 'in', ['draft', 'open', 'en_route', 'on_scene'])
      .orderBy('created_at')
      .execute()
  ).map((m) => {
    const route = (m.route ?? {}) as { area?: unknown; reports?: unknown };
    return {
      id: m.id,
      reference: m.reference,
      state: m.state,
      area: typeof route.area === 'string' ? route.area : null,
      reports: Array.isArray(route.reports)
        ? route.reports.filter((x): x is string => typeof x === 'string')
        : [],
    };
  });

const reportOut = z.object({
  id: z.uuid(),
  referenceCode: z.string(),
  parcelId: z.string().nullable(),
  photos: z.number().int(),
  requestedAt: z.string(),
  /** The open route this report is a stop on, if any. */
  routeMissionId: z.uuid().nullable(),
});

export const fieldVisitRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.get(
    '/reports/field-visits',
    {
      schema: {
        tags: ['reports'],
        querystring: z.object({ eventId: z.uuid() }),
        response: {
          200: z.object({
            groups: z.array(
              z.object({
                /** The parcels' route area; null when the reports have none (grouped by ZIP). */
                areaKey: z.string().nullable(),
                postal: z.string().nullable(),
                reports: z.array(reportOut),
                /** Reports not on any open route yet. */
                waiting: z.number().int(),
                routes: z.array(
                  z.object({ missionId: z.uuid(), reference: z.string(), state: z.string() }),
                ),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      const { eventId } = request.query;
      await request.authorize('report.read', { type: 'report', tenantId: s.tenantId, eventId });
      return request.tx(async (trx) => {
        const rows = await waitingReports(trx, eventId);
        const routes = await openRoutes(trx, eventId);
        const onRoute = new Map<string, string>();
        for (const r of routes) for (const id of r.reports) onRoute.set(id, r.id);
        const groups = new Map<
          string,
          { areaKey: string | null; postal: string | null; rows: Waiting[] }
        >();
        for (const r of rows) {
          const key = r.area_key ? `area:${r.area_key}` : `zip:${r.postal ?? ''}`;
          const g = groups.get(key) ?? {
            areaKey: r.area_key,
            postal: r.area_key ? null : r.postal,
            rows: [],
          };
          g.rows.push(r);
          groups.set(key, g);
        }
        const out = [...groups.values()].map((g) => {
          const reports = g.rows.map((r) => ({
            id: r.id,
            referenceCode: r.reference_code,
            parcelId: r.parcel_id,
            photos: Number(r.photos),
            requestedAt: r.field_visit_requested_at.toISOString(),
            routeMissionId: onRoute.get(r.id) ?? null,
          }));
          return {
            areaKey: g.areaKey,
            postal: g.postal,
            reports,
            waiting: reports.filter((r) => !r.routeMissionId).length,
            routes: routes
              .filter((r) => g.areaKey && r.area === g.areaKey)
              .map((r) => ({ missionId: r.id, reference: r.reference, state: r.state })),
          };
        });
        // Areas with the most reports waiting first; reports with no route area last.
        out.sort(
          (a, b) =>
            Number(a.areaKey === null) - Number(b.areaKey === null) ||
            b.waiting - a.waiting ||
            (a.areaKey ?? a.postal ?? '').localeCompare(b.areaKey ?? b.postal ?? ''),
        );
        return { groups: out };
      });
    },
  );

  app.post(
    '/reports/field-visits/routes',
    {
      schema: {
        tags: ['reports'],
        body: z.object({ eventId: z.uuid(), areaKey: z.string().min(1).max(80) }),
        response: {
          201: z.object({
            missionId: z.uuid(),
            reference: z.string(),
            reports: z.number().int(),
            stops: z.number().int(),
          }),
        },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const { eventId, areaKey } = request.body;
      await request.authorize('report.read', { type: 'report', tenantId: s.tenantId, eventId });
      const { rows, routes } = await request.tx(async (trx) => ({
        rows: await waitingReports(trx, eventId, areaKey),
        routes: await openRoutes(trx, eventId),
      }));
      const covered = new Set(routes.flatMap((r) => r.reports));
      // No-photo reports first (the route's order), then the oldest request.
      const todo = rows
        .filter((r) => !covered.has(r.id) && r.parcel_id)
        .sort((a, b) => Number(a.photos) - Number(b.photos));
      if (!todo.length)
        throw new ApiError(
          409,
          'nothing_to_route',
          'Every report waiting for a visit in this area is already on an open route.',
        );
      const stops = [...new Set(todo.map((r) => r.parcel_id!))];
      const first = todo.find((r) => r.lat !== null && r.lon !== null);
      // A location found by its point or address now names its parcel, so the team's visit at
      // that parcel links back to the report (DCL:DEC-02/03).
      const found = todo.filter((r) => !r.named_parcel);
      if (found.length)
        await request.tx(async (trx) => {
          for (const r of found)
            await trx
              .updateTable('cg.location')
              .set({ parcel_id: r.parcel_id, updated_by: s.accountId })
              .where('id', '=', r.location_id)
              .where('parcel_id', 'is', null)
              .execute();
          await request.audit(trx, {
            action: 'report.locate',
            targetType: 'event',
            targetId: eventId,
            changes: {
              fields: [
                { name: 'area', to: areaKey },
                { name: 'parcels_named', to: found.length },
              ],
            },
          });
        });
      const res = await instance.inject({
        method: 'POST',
        url: '/api/v1/missions',
        headers: {
          authorization: String(request.headers['authorization'] ?? ''),
          // The same reports in the same area open the same route, however often this is sent.
          'idempotency-key': stepKey(
            `${eventId}:${areaKey}:${todo
              .map((r) => r.id)
              .sort()
              .join(',')}`,
            'field-visit-route',
          ),
        },
        payload: {
          eventId,
          kind: 'verification_route',
          source: 'staff',
          priority: 'normal',
          urgency: 'soon',
          summary: `Field visits: ${areaKey.replace(/-/g, ' ')} (${todo.length} ${todo.length === 1 ? 'report' : 'reports'}, no-photo reports first)`,
          requiredCredentials: ['damage_assessor'],
          route: {
            area: areaKey,
            order: 'no_photo_first',
            stops,
            reports: todo.map((r) => r.id),
          },
          ...(first
            ? {
                location: {
                  landmark: `Route area ${areaKey.replace(/-/g, ' ')}`,
                  position: { lat: Number(first.lat), lon: Number(first.lon) },
                  state: 'approximate',
                },
              }
            : {}),
        },
      });
      if (res.statusCode === 403)
        throw new ApiError(403, 'forbidden', 'Opening a route needs the role that opens missions.');
      if (res.statusCode >= 300)
        throw new ApiError(res.statusCode, 'route_refused', 'The route could not be opened.', {
          details: res.json() as unknown,
        });
      const mission = res.json() as { id: string; reference: string };
      reply.code(201);
      return {
        missionId: mission.id,
        reference: mission.reference,
        reports: todo.length,
        stops: stops.length,
      };
    },
  );
};
