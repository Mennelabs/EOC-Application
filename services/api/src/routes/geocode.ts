/**
 * Address suggestions and reverse geocoding for staff (BRD:FR-03.02,
 * ADR-0015). The county's own parcel data answers first: its addresses are
 * the address of record and a match there is a verified place. A self-hosted
 * Nominatim (the "maps" profile, GEOCODER_URL) adds OpenStreetMap matches,
 * which are approximate. When the geocoder is off or slow the answer is the
 * parcels alone, and the forms still take a typed address or a landmark
 * (SCL-06: maps off, work goes on). Nothing typed is stored here.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { errors } from '../errors.ts';

export interface GeocodeDeps {
  /** Base URL of a self-hosted Nominatim, e.g. http://geocoder:8080; absent means parcels only. */
  nominatimUrl?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const placeOut = z.object({
  label: z.string(),
  line1: z.string().nullable(),
  city: z.string().nullable(),
  postal: z.string().nullable(),
  position: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  /** parcel: the county's address of record (verified); osm: OpenStreetMap (approximate). */
  source: z.enum(['parcel', 'osm']),
  parcelId: z.string().nullable(),
});
type Place = z.infer<typeof placeOut>;

interface Nominatim {
  lat: string;
  lon: string;
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    postcode?: string;
  };
}

const fromNominatim = (n: Nominatim): Place => {
  const a = n.address ?? {};
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ') || null;
  const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? null;
  return {
    label: [line1, city, a.postcode].filter(Boolean).join(', ') || (n.display_name ?? ''),
    line1,
    city,
    postal: a.postcode ?? null,
    position: { lat: Number(n.lat), lon: Number(n.lon) },
    source: 'osm',
    parcelId: null,
  };
};

export const geocodeRoutes =
  (deps: GeocodeDeps = {}): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();
    const doFetch = deps.fetch ?? fetch;
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    /** Nominatim when configured; any failure or a slow answer is simply no OSM matches. */
    const nominatim = async (path: string): Promise<Nominatim[]> => {
      if (!deps.nominatimUrl) return [];
      try {
        const res = await doFetch(`${deps.nominatimUrl.replace(/\/$/, '')}${path}`, {
          signal: AbortSignal.timeout(deps.timeoutMs ?? 1500),
          headers: { accept: 'application/json' },
        });
        if (!res.ok) return [];
        const body = (await res.json()) as Nominatim[] | Nominatim;
        return Array.isArray(body) ? body : body && 'lat' in body ? [body] : [];
      } catch {
        return [];
      }
    };

    app.get(
      '/geocode/suggest',
      {
        schema: {
          tags: ['geocoding'],
          querystring: z.object({
            q: z.string().trim().min(3).max(200),
            limit: z.coerce.number().int().min(1).max(10).default(6),
          }),
          response: { 200: z.array(placeOut) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('mission.create', { type: 'mission', tenantId: s.tenantId });
        const { q, limit } = request.query;
        // Every word typed appears in the address, city or ZIP, in any order ("Maple 101 Harmon").
        const words = q
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 6)
          .map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const parcels = await request.tx((trx) => {
          let x = trx
            .selectFrom('cg.parcel')
            .select([
              'parcel_id',
              'line1',
              'city',
              'postal',
              sql<number>`ST_Y(centroid)`.as('lat'),
              sql<number>`ST_X(centroid)`.as('lon'),
            ])
            .where('line1', 'is not', null);
          for (const w of words)
            x = x.where(sql<string>`concat_ws(' ', line1, city, postal)`, 'ilike', w);
          return x.orderBy('line1').limit(limit).execute();
        });
        const out: Place[] = parcels.map((p) => ({
          label: [p.line1, p.city, p.postal].filter(Boolean).join(', '),
          line1: p.line1,
          city: p.city,
          postal: p.postal,
          position: { lat: Number(p.lat), lon: Number(p.lon) },
          source: 'parcel',
          parcelId: p.parcel_id,
        }));
        if (out.length < limit) {
          const more = await nominatim(
            `/search?format=jsonv2&addressdetails=1&countrycodes=us&limit=${limit - out.length}&q=${encodeURIComponent(q)}`,
          );
          const seen = new Set(out.map((p) => p.label.toLowerCase()));
          for (const n of more.map(fromNominatim))
            if (!seen.has(n.label.toLowerCase())) out.push(n);
        }
        return out.slice(0, limit);
      },
    );

    app.get(
      '/geocode/reverse',
      {
        schema: {
          tags: ['geocoding'],
          querystring: z.object({
            lat: z.coerce.number().min(-90).max(90),
            lon: z.coerce.number().min(-180).max(180),
          }),
          response: { 200: placeOut },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('mission.create', { type: 'mission', tenantId: s.tenantId });
        const { lat, lon } = request.query;
        // FR-03.03: 0,0 is never a place.
        if (lat === 0 && lon === 0) throw errors.notFound();
        const point = sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`;
        const parcel = await request.tx((trx) =>
          trx
            .selectFrom('cg.parcel')
            .select([
              'parcel_id',
              'line1',
              'city',
              'postal',
              sql<number>`ST_Y(centroid)`.as('lat'),
              sql<number>`ST_X(centroid)`.as('lon'),
            ])
            .where(sql<boolean>`ST_DWithin(geom::geography, ${point}::geography, 30)`)
            .where('line1', 'is not', null)
            .orderBy(sql`ST_Distance(geom::geography, ${point}::geography)`)
            .limit(1)
            .executeTakeFirst(),
        );
        if (parcel)
          return {
            label: [parcel.line1, parcel.city, parcel.postal].filter(Boolean).join(', '),
            line1: parcel.line1,
            city: parcel.city,
            postal: parcel.postal,
            position: { lat, lon },
            source: 'parcel' as const,
            parcelId: parcel.parcel_id,
          };
        const [n] = await nominatim(
          `/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lon}`,
        );
        if (!n) throw errors.notFound();
        return { ...fromNominatim(n), position: { lat, lon } };
      },
    );
  };
