/**
 * Situation map area layers (layer-6 task J; CON-03, CON-07, EQ-11, EQ-13,
 * DCL:DEC-03, DCL:DEC-07): the tracts in view (the event's area when drawn,
 * otherwise the county's) with
 *
 * - damage: housing units counted by the counting rule, by tract;
 * - coverage (the equity map): reports per 100 residential structures, with
 *   the tracts under the tenant's coverage threshold flagged and counts from
 *   1 to 10 hidden with anything worked out from them (EQ-13);
 * - the Census profile: share below poverty and share of limited-English
 *   households (ACS, public);
 * - outages not yet restored, placed at their facility when it is known.
 *
 * Each layer is checked on its own read action, names its source and the
 * time it is as of, and is a table in the console as well as a shading on
 * the map (ACC-07). Nothing here is a person: counts, rates and shares.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { countDamage, currentSnapshot, equityData, loadDamageRecords } from '@cg/reporting';
import { errors } from '../errors.ts';
import { iso } from './helpers.ts';

const MAX_TRACTS = 2000;

const value = z.object({
  geoid: z.string(),
  /** Null when unknown, or hidden because it rests on 1 to 10 people or homes. */
  value: z.number().nullable(),
  flagged: z.boolean(),
  detail: z.string().nullable(),
});
const areaLayer = z.object({
  available: z.boolean(),
  title: z.string(),
  unit: z.string(),
  source: z.string().nullable(),
  asOf: z.string().nullable(),
  items: z.array(value),
});
const outageItem = z.object({
  id: z.uuid(),
  position: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  label: z.string(),
  state: z.string(),
  detail: z.string().nullable(),
});
const areasOut = z.object({
  eventId: z.uuid(),
  asOf: z.string(),
  basis: z.enum(['footprint', 'county', 'none']),
  tracts: z.array(
    z.object({ geoid: z.string(), name: z.string().nullable(), geometry: z.unknown() }),
  ),
  tractSource: z.string().nullable(),
  layers: z.object({
    damage: areaLayer,
    coverage: areaLayer,
    poverty: areaLayer,
    limitedEnglish: areaLayer,
  }),
  outages: z.object({
    available: z.boolean(),
    source: z.string().nullable(),
    asOf: z.string().nullable(),
    items: z.array(outageItem),
  }),
});

const KIND: Record<string, string> = {
  hospital: 'Hospital',
  water: 'Water',
  wastewater: 'Wastewater',
  police: 'Police',
  fire_ems: 'Fire and EMS',
  school: 'School',
  child_care: 'Child care',
  eldercare: 'Elder care',
  roads: 'Roads',
  power: 'Power',
};

export const situationAreaRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  async function may(request: FastifyRequest, action: string, resource: Record<string, unknown>) {
    return request
      .authorize(action, resource as never)
      .then(() => true)
      .catch(() => false);
  }

  app.get(
    '/situation/areas',
    {
      schema: {
        tags: ['dispatch'],
        querystring: z.object({ eventId: z.uuid() }),
        response: { 200: areasOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const eventId = request.query.eventId;
      const base = { tenantId: s.tenantId, eventId };
      const [declaration, equity, refdata] = await Promise.all([
        may(request, 'declaration.read', { type: 'declaration', ...base }),
        may(request, 'equity.read', { type: 'equity', ...base }),
        may(request, 'refdata.read', { type: 'refdata', ...base }),
      ]);
      if (!declaration && !equity && !refdata) throw errors.forbidden();
      const census = declaration || equity || refdata;
      return request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select(['id', 'tenant_id', sql<boolean>`footprint is not null`.as('has_footprint')])
          .where('id', '=', eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        const tenantId = event.tenant_id;
        const asOf = new Date().toISOString();
        const tractSnap = await currentSnapshot(trx, tenantId, 'tract');
        const profileSnap = await currentSnapshot(trx, tenantId, 'tract_profile');
        const structureSnap = await currentSnapshot(trx, tenantId, 'structure');
        const tracts = tractSnap
          ? (
              await sql<{ geoid: string; name: string | null; geometry: string | null }>`
                select t.geoid, t.name,
                  st_asgeojson(st_simplifypreservetopology(t.geom, 0.0002), 5) as geometry
                from cg.ref_tract t
                ${event.has_footprint ? sql`join cg.event e on e.id = ${eventId}::uuid and st_intersects(t.geom, e.footprint)` : sql``}
                where t.snapshot_id = ${tractSnap.id}::uuid
                order by t.geoid limit ${MAX_TRACTS}`.execute(trx)
            ).rows
          : [];
        const inView = new Set(tracts.map((t) => t.geoid));
        const cite = (
          snap: { vintage: string | null; retrieved_at: Date } | undefined,
          what: string,
        ) => (snap ? `${what}${snap.vintage ? `, ${snap.vintage}` : ''}` : null);

        // DCL:DEC-03: the counting rule's housing units by tract.
        const damage = declaration
          ? countDamage(await loadDamageRecords(trx, eventId)).counted.byTract.filter(
              (t) => t.tractGeoid && inView.has(t.tractGeoid),
            )
          : [];
        // EQ-11, EQ-13, CON-07: coverage and the Census profile as the equity screen computes them.
        const eq = equity || census ? await equityData(trx, tenantId, eventId) : null;
        const pct = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

        const outages = declaration
          ? await sql<{
              id: string;
              kind: string;
              facility_name: string | null;
              area: string | null;
              customers_out: number | null;
              started_at: Date;
              expected_restoration_at: Date | null;
              confirmed_at: Date | null;
              lat: number | null;
              lon: number | null;
            }>`
              select o.id, o.kind, o.facility_name, o.area, o.customers_out, o.started_at,
                o.expected_restoration_at, o.confirmed_at,
                st_y(f.geom) as lat, st_x(f.geom) as lon
              from cg.outage o
              left join cg.refdata_current c on c.tenant_id = o.tenant_id and c.dataset = 'facility'
              left join cg.ref_facility f on f.snapshot_id = c.snapshot_id
                and f.source_id = o.facility_source_id
              where o.event_id = ${eventId}::uuid and o.restored_at is null
              order by o.started_at`.execute(trx)
          : { rows: [] };

        return {
          eventId,
          asOf,
          basis: (tractSnap ? (event.has_footprint ? 'footprint' : 'county') : 'none') as
            'footprint' | 'county' | 'none',
          tracts: tracts.map((t) => ({
            geoid: t.geoid,
            name: t.name,
            geometry: t.geometry ? (JSON.parse(t.geometry) as unknown) : null,
          })),
          tractSource: cite(tractSnap, 'Census tracts (TIGER)'),
          layers: {
            damage: {
              available: declaration,
              title: 'Damaged housing units',
              unit: 'housing units',
              source: 'Verified reports and field assessments, by the counting rule',
              asOf,
              items: damage.map((t) => ({
                geoid: t.tractGeoid!,
                value: t.units,
                flagged: false,
                detail:
                  Object.entries(t.byDegree)
                    .filter(([, n]) => n > 0)
                    .map(([d, n]) => `${d}: ${n}`)
                    .join('; ') || null,
              })),
            },
            coverage: {
              available: equity,
              title: 'Reports per 100 homes',
              unit: 'reports per 100 residential structures',
              source: cite(structureSnap, 'Reports against residential structures (NSI)'),
              asOf,
              items: equity
                ? (eq?.tracts ?? [])
                    .filter((t) => inView.has(t.geoid))
                    .map((t) => ({
                      geoid: t.geoid,
                      value: t.reportsPer100Structures,
                      flagged: t.underReported,
                      detail:
                        t.reports === null
                          ? 'Fewer than 11 reports'
                          : `${t.reports} reports${t.structures !== null ? `, ${t.structures} residential structures` : ''}`,
                    }))
                : [],
            },
            poverty: {
              available: census,
              title: 'Share below poverty',
              unit: 'percent of people',
              source: cite(profileSnap, 'American Community Survey'),
              asOf: profileSnap ? iso(profileSnap.retrieved_at) : null,
              items: census
                ? (eq?.tracts ?? [])
                    .filter((t) => inView.has(t.geoid))
                    .map((t) => ({
                      geoid: t.geoid,
                      value: pct(t.povertyPct),
                      flagged: false,
                      detail: t.incomeBand ? `Income band ${t.incomeBand} of 5` : null,
                    }))
                : [],
            },
            limitedEnglish: {
              available: census,
              title: 'Limited-English households',
              unit: 'percent of households',
              source: cite(profileSnap, 'American Community Survey'),
              asOf: profileSnap ? iso(profileSnap.retrieved_at) : null,
              items: census
                ? (eq?.tracts ?? [])
                    .filter((t) => inView.has(t.geoid))
                    .map((t) => ({
                      geoid: t.geoid,
                      value: pct(t.limitedEnglishPct),
                      flagged: false,
                      detail: t.households !== null ? `${t.households} households` : null,
                    }))
                : [],
            },
          },
          outages: {
            available: declaration,
            source: 'Outages recorded for the event',
            asOf,
            items: outages.rows.map((o) => ({
              id: o.id,
              position:
                o.lat !== null && o.lon !== null
                  ? { lat: Number(o.lat), lon: Number(o.lon) }
                  : null,
              label: `${KIND[o.kind] ?? o.kind}: ${o.facility_name ?? o.area ?? 'area not given'}`,
              state: o.confirmed_at ? 'confirmed' : 'not confirmed',
              detail:
                [
                  `Out since ${iso(o.started_at)}`,
                  o.customers_out !== null ? `${o.customers_out} customers` : null,
                  o.expected_restoration_at
                    ? `expected back ${iso(o.expected_restoration_at)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join('; ') || null,
            })),
          },
        };
      });
    },
  );
};
