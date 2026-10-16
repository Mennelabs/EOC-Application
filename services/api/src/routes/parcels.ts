/**
 * A county's parcels and route areas from its GIS (CON-17, SCL-13: "counties'
 * parcel data is loaded per tenant"; Esri ArcGIS, Survey123/Field Maps and
 * QGIS through import and export). Parcels arrive as GeoJSON exported from
 * the county's system, in batches, with a mapping from its property names to
 * ours (parcel id, address, city, ZIP, units, structure); a parcel already
 * loaded is updated by its id. Route areas arrive as polygons, each named by
 * a property: the parcels inside a polygon take its name as their area, which
 * is what a verification route and the phone's area package are cut by
 * (FLD-04, FLD-13). The importer may also open a draft verification route for
 * each area, through the usual mission step and its own permissions.
 * Geometry that is not a polygon, or not valid, is refused per feature and
 * named back. Every import is audited with its counts.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { errors } from '../errors.ts';
import { stepKey } from './helpers.ts';

const structures = [
  'single_family',
  'manufactured',
  'apartment_building',
  'commercial',
  'public',
  'vacant',
  'other',
] as const;

const featureIn = z.object({
  type: z.literal('Feature'),
  geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable().optional(),
  properties: z.record(z.string(), z.unknown()).nullable().optional(),
});
type Feature = z.infer<typeof featureIn>;

const text = (v: unknown, max: number) =>
  v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, max);

/** A route name as an area key: lower case, words joined by dashes. */
export const areaKeyOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);

const polygonal = (f: Feature) =>
  f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');

export const parcelRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.get(
    '/parcels/summary',
    {
      schema: {
        tags: ['gis'],
        response: {
          200: z.object({
            parcels: z.number().int(),
            bySource: z.array(z.object({ source: z.string(), parcels: z.number().int() })),
            areas: z.array(z.object({ areaKey: z.string(), parcels: z.number().int() })),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('parcel.read', { type: 'parcel', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const bySource = await trx
          .selectFrom('cg.parcel')
          .select(['source', sql<string>`count(*)`.as('n')])
          .groupBy('source')
          .orderBy('source')
          .execute();
        const areas = await trx
          .selectFrom('cg.parcel')
          .select(['area_key', sql<string>`count(*)`.as('n')])
          .where('area_key', 'is not', null)
          .groupBy('area_key')
          .orderBy('area_key')
          .limit(500)
          .execute();
        return {
          parcels: bySource.reduce((n, r) => n + Number(r.n), 0),
          bySource: bySource.map((r) => ({ source: r.source, parcels: Number(r.n) })),
          areas: areas.map((r) => ({ areaKey: r.area_key!, parcels: Number(r.n) })),
        };
      });
    },
  );

  app.post(
    '/parcels/import',
    {
      bodyLimit: 25 * 1024 * 1024,
      schema: {
        tags: ['gis'],
        body: z.object({
          features: z.array(featureIn).min(1).max(2000),
          /** The county's property names for each of ours; only parcelId is required. */
          mapping: z.object({
            parcelId: z.string().min(1).max(80),
            line1: z.string().max(80).optional(),
            city: z.string().max(80).optional(),
            postal: z.string().max(80).optional(),
            units: z.string().max(80).optional(),
            structure: z.string().max(80).optional(),
          }),
        }),
        response: {
          200: z.object({
            inserted: z.number().int(),
            updated: z.number().int(),
            rejected: z.number().int(),
            problems: z.array(z.object({ index: z.number().int(), reason: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('parcel.import', { type: 'parcel', tenantId: s.tenantId });
      const { features, mapping } = request.body;
      const problems: { index: number; reason: string }[] = [];
      let inserted = 0;
      let updated = 0;
      await request.tx(async (trx) => {
        for (const [index, f] of features.entries()) {
          const props = f.properties ?? {};
          const parcelId = text(props[mapping.parcelId], 80);
          if (!parcelId) {
            problems.push({ index, reason: `no ${mapping.parcelId}` });
            continue;
          }
          if (!polygonal(f)) {
            problems.push({ index, reason: 'not a polygon' });
            continue;
          }
          const geojson = JSON.stringify(f.geometry);
          const valid = await sql<{ ok: boolean }>`
            select ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)) as ok`
            .execute(trx)
            .then((r) => r.rows[0]?.ok ?? false)
            .catch(() => false);
          if (!valid) {
            problems.push({ index, reason: 'geometry is not valid' });
            continue;
          }
          const units = Number(text(mapping.units ? props[mapping.units] : null, 10));
          const structureRaw = text(mapping.structure ? props[mapping.structure] : null, 40);
          const structure = (structures as readonly string[]).includes(structureRaw ?? '')
            ? (structureRaw as (typeof structures)[number])
            : 'other';
          const values = {
            geom: sql`ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326))`,
            line1: text(mapping.line1 ? props[mapping.line1] : null, 200),
            city: text(mapping.city ? props[mapping.city] : null, 100),
            postal: text(mapping.postal ? props[mapping.postal] : null, 12),
            unit_count: Number.isInteger(units) && units > 0 && units < 10_000 ? units : null,
            structure,
            source: 'import',
            loaded_at: new Date(),
            updated_by: s.accountId,
          };
          const row = await trx
            .insertInto('cg.parcel')
            .values({
              tenant_id: s.tenantId,
              parcel_id: parcelId,
              created_by: s.accountId,
              ...values,
            } as never)
            .onConflict((oc) => oc.columns(['tenant_id', 'parcel_id']).doUpdateSet(values as never))
            .returning(sql<boolean>`(xmax = 0)`.as('fresh'))
            .executeTakeFirstOrThrow();
          if (row.fresh) inserted += 1;
          else updated += 1;
        }
        await request.audit(trx, {
          action: 'parcel.import',
          targetType: 'parcel',
          targetId: 'import',
          changes: {
            fields: [
              { name: 'inserted', to: inserted },
              { name: 'updated', to: updated },
              { name: 'rejected', to: problems.length },
            ],
          },
        });
      });
      return { inserted, updated, rejected: problems.length, problems: problems.slice(0, 50) };
    },
  );

  app.post(
    '/parcels/routes/import',
    {
      bodyLimit: 10 * 1024 * 1024,
      schema: {
        tags: ['gis'],
        body: z.object({
          features: z.array(featureIn).min(1).max(500),
          /** The property that names each route area. */
          nameProperty: z.string().min(1).max(80),
          /** Open a draft verification route for each area in this event (the importer's own permission). */
          missionsFor: z.uuid().optional(),
        }),
        response: {
          200: z.object({
            routes: z.array(
              z.object({
                name: z.string(),
                areaKey: z.string(),
                parcels: z.number().int(),
                missionId: z.uuid().nullable(),
              }),
            ),
            problems: z.array(z.object({ index: z.number().int(), reason: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('parcel.import', { type: 'parcel', tenantId: s.tenantId });
      const { features, nameProperty, missionsFor } = request.body;
      const problems: { index: number; reason: string }[] = [];
      const routes: {
        name: string;
        areaKey: string;
        parcels: number;
        centroid: [number, number] | null;
      }[] = [];
      await request.tx(async (trx) => {
        for (const [index, f] of features.entries()) {
          const name = text((f.properties ?? {})[nameProperty], 120);
          const areaKey = name ? areaKeyOf(name) : '';
          if (!name || !areaKey) {
            problems.push({ index, reason: `no ${nameProperty}` });
            continue;
          }
          if (!polygonal(f)) {
            problems.push({ index, reason: 'not a polygon' });
            continue;
          }
          const geojson = JSON.stringify(f.geometry);
          const shape = sql`ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)`;
          const ok = await sql<{ ok: boolean; lat: number; lon: number }>`
            select ST_IsValid(${shape}) as ok,
                   ST_Y(ST_PointOnSurface(${shape})) as lat, ST_X(ST_PointOnSurface(${shape})) as lon`
            .execute(trx)
            .then((r) => r.rows[0] ?? null)
            .catch(() => null);
          if (!ok?.ok) {
            problems.push({ index, reason: 'geometry is not valid' });
            continue;
          }
          // The parcels whose centre lies inside the polygon belong to the route area.
          const moved = await trx
            .updateTable('cg.parcel')
            .set({ area_key: areaKey, updated_by: s.accountId })
            .where(sql<boolean>`ST_Within(centroid, ${shape})`)
            .executeTakeFirst();
          routes.push({
            name,
            areaKey,
            parcels: Number(moved.numUpdatedRows ?? 0),
            centroid: [Number(ok.lat), Number(ok.lon)],
          });
        }
        await request.audit(trx, {
          action: 'parcel.import',
          targetType: 'parcel',
          targetId: 'routes',
          changes: {
            fields: [
              { name: 'routes', to: routes.length },
              { name: 'rejected', to: problems.length },
            ],
          },
        });
      });
      // A draft verification route per area, through the usual mission step (its own checks and audit).
      const out = [];
      for (const r of routes) {
        let missionId: string | null = null;
        if (missionsFor) {
          const res = await instance.inject({
            method: 'POST',
            url: '/api/v1/missions',
            headers: {
              authorization: String(request.headers['authorization'] ?? ''),
              'idempotency-key': stepKey(`${missionsFor}:${r.areaKey}`, 'route'),
            },
            payload: {
              eventId: missionsFor,
              kind: 'verification_route',
              source: 'staff',
              priority: 'normal',
              urgency: 'soon',
              save: 'draft',
              summary: `Verification route: ${r.name} (no-photo reports first)`,
              route: { area: r.areaKey, order: 'no_photo_first', stops: [] },
              ...(r.centroid
                ? {
                    location: {
                      landmark: r.name,
                      position: { lat: r.centroid[0], lon: r.centroid[1] },
                      state: 'approximate',
                    },
                  }
                : {}),
            },
          });
          if (res.statusCode < 300) missionId = (res.json() as { id: string }).id;
          else
            problems.push({
              index: -1,
              reason: `${r.name}: no route mission (${res.statusCode === 403 ? 'opening missions needs the mission role' : 'refused'})`,
            });
        }
        out.push({ name: r.name, areaKey: r.areaKey, parcels: r.parcels, missionId });
      }
      return { routes: out, problems: problems.slice(0, 50) };
    },
  );
};
