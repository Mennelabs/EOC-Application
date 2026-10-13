/**
 * Situation map layers (layer-4 plan console 12; CON-03, AC-03C, DSP-08,
 * PUB-05, RULE-16, SEC-05, SEC-18): one answer with every layer the caller's
 * role may see for an event: reports, danger flags, verified damage, needs,
 * sites, teams, hazards and the event footprint. Each layer is checked on
 * its own read action and says plainly when the role does not include it.
 * Exact report and need locations need the exact-location category;
 * otherwise points are rounded to about a kilometre. Confidential sites
 * (PUB-05) never appear. Team positions follow the board's rules: only for
 * roles that read positions, at the tenant's precision. Danger flags are
 * awareness only (CON-10): this answer dispatches nothing.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import type { FieldDescriptor } from '@cg/authz';
import { errors } from '../errors.ts';
import { configValue } from '../public/submit.ts';

const point = z.object({ lat: z.number(), lon: z.number() });
const item = z.object({
  id: z.uuid(),
  position: point,
  /** True when the point was rounded because the role does not see exact locations. */
  approximate: z.boolean(),
  label: z.string(),
  state: z.string().nullable(),
  detail: z.string().nullable(),
});
const layer = z.object({ available: z.boolean(), items: z.array(item) });
const situationOut = z.object({
  eventId: z.uuid(),
  asOf: z.string(),
  layers: z.object({
    reports: layer,
    dangerFlags: layer,
    verifiedDamage: layer,
    needs: layer,
    sites: layer,
    teams: layer,
    hazards: layer,
  }),
  /** GeoJSON MultiPolygon of the event's area, when drawn. */
  footprint: z.unknown().nullable(),
});

const LOCATION: FieldDescriptor[] = [
  { name: 'location', category: 'location_exact', classification: 'sensitive' },
];
/** About a kilometre: enough to see where the work is, not whose house it is. */
const round = (v: number) => Math.round(v * 100) / 100;

export const situationRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** The decision when the role may read this layer, or null (the layer is then "not available"). */
  async function may(request: FastifyRequest, action: string, resource: Record<string, unknown>) {
    return request
      .authorize(action, resource as never)
      .then((d) => d)
      .catch(() => null);
  }

  app.get(
    '/situation',
    {
      schema: {
        tags: ['dispatch'],
        querystring: z.object({ eventId: z.uuid() }),
        response: { 200: situationOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const eventId = request.query.eventId;
      const base = { tenantId: s.tenantId, eventId };
      const [reports, needs, sites, hazards, teams, positions, events] = await Promise.all([
        may(request, 'report.read', { type: 'report', ...base, fields: LOCATION }),
        may(request, 'need.read', { type: 'need', ...base, fields: LOCATION }),
        may(request, 'site.read', { type: 'site', ...base }),
        may(request, 'hazard.read', { type: 'hazard', ...base }),
        may(request, 'team.read', { type: 'team', ...base }),
        may(request, 'position.read', { type: 'position', ...base }),
        may(request, 'event.read', { type: 'event', ...base }),
      ]);
      if (!events && !reports && !sites && !teams) throw errors.forbidden();
      const exactReports = !!reports?.fields.includes('location');
      const exactNeeds = !!needs?.fields.includes('location');
      return request.tx(async (trx) => {
        const place = (lat: unknown, lon: unknown, exact: boolean) => {
          const p = { lat: Number(lat), lon: Number(lon) };
          return exact
            ? { position: p, approximate: false }
            : { position: { lat: round(p.lat), lon: round(p.lon) }, approximate: true };
        };
        const reportRows = reports
          ? await trx
              .selectFrom('cg.report as r')
              .innerJoin('cg.location as l', 'l.id', 'r.location_id')
              .select([
                'r.id',
                'r.reference_code',
                'r.review_state',
                'r.verification_level',
                'r.fema_degree',
                'r.danger_flag',
                sql<number>`ST_Y(l.geom)`.as('lat'),
                sql<number>`ST_X(l.geom)`.as('lon'),
              ])
              .where('r.event_id', '=', eventId)
              .where('r.withdrawn_at', 'is', null)
              .where('r.duplicate_of', 'is', null)
              .where(sql<boolean>`l.geom is not null`)
              .limit(5000)
              .execute()
          : [];
        const toReport = (r: (typeof reportRows)[number]) => ({
          id: r.id,
          ...place(r.lat, r.lon, exactReports),
          label: r.reference_code,
          state: r.review_state,
          detail: r.fema_degree ? `FEMA degree: ${r.fema_degree.replace(/_/g, ' ')}` : null,
        });
        const needRows = needs
          ? await trx
              .selectFrom('cg.need as n')
              .innerJoin('cg.location as l', 'l.id', 'n.location_id')
              .select([
                'n.id',
                'n.category',
                'n.status',
                sql<number>`ST_Y(l.geom)`.as('lat'),
                sql<number>`ST_X(l.geom)`.as('lon'),
              ])
              .where('n.event_id', '=', eventId)
              .where('n.status', 'in', ['open', 'claimed', 'in_progress'])
              .where(sql<boolean>`l.geom is not null`)
              .limit(5000)
              .execute()
          : [];
        const siteRows = sites
          ? await trx
              .selectFrom('cg.site as st')
              .innerJoin('cg.location as l', 'l.id', 'st.location_id')
              .select([
                'st.id',
                'st.name',
                'st.kind',
                'st.status',
                'st.occupancy',
                'st.capacity',
                sql<number>`ST_Y(l.geom)`.as('lat'),
                sql<number>`ST_X(l.geom)`.as('lon'),
              ])
              .where((eb) =>
                eb.or([eb('st.event_id', '=', eventId), eb('st.event_id', 'is', null)]),
              )
              // PUB-05: a confidential site is never on any map.
              .where('st.confidential', '=', false)
              .where(sql<boolean>`l.geom is not null`)
              .execute()
          : [];
        const hazardRows = hazards
          ? await trx
              .selectFrom('cg.hazard')
              .select([
                'id',
                'kind',
                'state',
                'severity',
                'summary',
                sql<number>`ST_Y(geom)`.as('lat'),
                sql<number>`ST_X(geom)`.as('lon'),
              ])
              .where('event_id', '=', eventId)
              .where('state', '<>', 'cleared')
              .where(sql<boolean>`geom is not null`)
              .execute()
          : [];
        // DSP-08: team positions only for roles that read positions, at the tenant's precision.
        const precision =
          Number((await configValue<number | string>(trx, 'field.position_precision_m')) ?? 0) || 0;
        const teamRows =
          teams && positions
            ? await trx
                .selectFrom('cg.position as p')
                .innerJoin('cg.team as t', 't.id', 'p.team_id')
                .innerJoin('cg.check_in as c', 'c.id', 'p.check_in_id')
                .select([
                  't.id',
                  't.name',
                  't.callsign',
                  sql<number>`ST_Y(p.geom)`.as('lat'),
                  sql<number>`ST_X(p.geom)`.as('lon'),
                  'p.recorded_at',
                ])
                .distinctOn('t.id')
                .where('c.event_id', '=', eventId)
                .where('c.ended_at', 'is', null)
                .where('p.recorded_at', '>', new Date(Date.now() - 12 * 3_600_000))
                .orderBy('t.id')
                .orderBy('p.recorded_at', 'desc')
                .execute()
            : [];
        const snap = (v: number) => {
          if (!precision) return v;
          const step = precision / 111_000;
          return Math.round(v / step) * step;
        };
        const footprint = events
          ? await trx
              .selectFrom('cg.event')
              .select(sql<string | null>`ST_AsGeoJSON(footprint)`.as('geojson'))
              .where('id', '=', eventId)
              .executeTakeFirst()
          : undefined;
        if (reports && !exactReports)
          request.log.debug({ eventId }, 'situation: report points rounded for this role');
        if (reports && exactReports)
          await request.audit(trx, {
            action: 'report.read',
            targetType: 'event',
            targetId: eventId,
            changes: { fields: [{ name: 'situation_exact_locations', to: reportRows.length }] },
          });
        return {
          eventId,
          asOf: new Date().toISOString(),
          layers: {
            reports: { available: !!reports, items: reportRows.map(toReport) },
            // CON-10: awareness only; the resident was told to call 911.
            dangerFlags: {
              available: !!reports,
              items: reportRows.filter((r) => r.danger_flag).map(toReport),
            },
            verifiedDamage: {
              available: !!reports,
              items: reportRows
                .filter(
                  (r) =>
                    ['field_verified', 'desktop_verified'].includes(String(r.verification_level)) &&
                    r.fema_degree,
                )
                .map(toReport),
            },
            needs: {
              available: !!needs,
              items: needRows.map((n) => ({
                id: n.id,
                ...place(n.lat, n.lon, exactNeeds),
                label: n.category.replace(/_/g, ' '),
                state: n.status,
                detail: null,
              })),
            },
            sites: {
              available: !!sites,
              items: siteRows.map((x) => ({
                id: x.id,
                position: { lat: Number(x.lat), lon: Number(x.lon) },
                approximate: false,
                label: x.name,
                state: x.status,
                detail:
                  x.capacity !== null
                    ? `${x.kind.replace(/_/g, ' ')} · ${x.occupancy ?? '?'} of ${x.capacity}`
                    : x.kind.replace(/_/g, ' '),
              })),
            },
            teams: {
              available: !!(teams && positions),
              items: teamRows.map((t) => ({
                id: t.id,
                position: { lat: snap(Number(t.lat)), lon: snap(Number(t.lon)) },
                approximate: precision > 0,
                label: t.callsign ? `${t.name} (${t.callsign})` : t.name,
                state: null,
                detail: `Position from ${new Date(t.recorded_at).toISOString()}`,
              })),
            },
            hazards: {
              available: !!hazards,
              items: hazardRows.map((h) => ({
                id: h.id,
                position: { lat: Number(h.lat), lon: Number(h.lon) },
                approximate: false,
                label: h.kind.replace(/_/g, ' '),
                state: h.state,
                detail: `${h.severity}${h.summary ? ` · ${h.summary}` : ''}`,
              })),
            },
          },
          footprint: footprint?.geojson ? (JSON.parse(footprint.geojson) as unknown) : null,
        };
      });
    },
  );
};
