/**
 * Routing and travel times (CON-14; layer-8 plan §6 and §13 question 2;
 * ADR-0046): a self-hosted OSRM built from the same OpenStreetMap extract
 * as the tiles (compose profile `routing`, ROUTING_URL). A route is a
 * distance, a driving time and a line, labelled with its source and when it
 * was computed; closures the router does not know are shown beside it from
 * live conditions, never hidden. Without the container the answer is the
 * straight-line distance, said so (SCL-06: maps off, work goes on). Google
 * Maps Platform is not used (a paid service; Adam decides).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.ts';

export interface RoutingDeps {
  /** Base URL of the self-hosted OSRM, e.g. http://routing:5000; absent means straight lines only. */
  routingUrl?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Point {
  lat: number;
  lon: number;
}
export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
  /** GeoJSON LineString of the route, when the router gave one. */
  geometry: { type: 'LineString'; coordinates: number[][] } | null;
  source: 'osrm' | 'straight_line';
}

const EARTH_KM = 6371;
/** Great-circle distance, the fallback when no router runs. */
export function straightLineKm(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

interface OsrmResponse {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { type?: string; coordinates?: unknown };
  }[];
}

/**
 * One driving route from OSRM's route service (v1), or null when the router
 * is off, slow, or finds no road between the points.
 */
export async function osrmRoute(
  doFetch: typeof fetch,
  routingUrl: string,
  from: Point,
  to: Point,
  timeoutMs = 2000,
): Promise<RouteResult | null> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = `${routingUrl.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=simplified&geometries=geojson&alternatives=false&steps=false`;
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OsrmResponse;
    const r = body.routes?.[0];
    if (
      body.code !== 'Ok' ||
      !r ||
      typeof r.distance !== 'number' ||
      typeof r.duration !== 'number'
    )
      return null;
    const g = r.geometry;
    const geometry =
      g?.type === 'LineString' && Array.isArray(g.coordinates)
        ? { type: 'LineString' as const, coordinates: g.coordinates as number[][] }
        : null;
    return {
      distanceKm: Math.round(r.distance / 10) / 100,
      durationMinutes: Math.round(r.duration / 6) / 10,
      geometry,
      source: 'osrm',
    };
  } catch {
    return null;
  }
}

/** Average speed for the straight-line estimate, in km/h: a county road after a storm. */
const FALLBACK_KMH = 40;

export const routingRoutes =
  (deps: RoutingDeps = {}): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();
    const doFetch = deps.fetch ?? fetch;
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    const coord = z.coerce.number();

    app.get(
      '/routing/route',
      {
        schema: {
          tags: ['routing'],
          querystring: z.object({
            fromLat: coord.min(-90).max(90),
            fromLon: coord.min(-180).max(180),
            toLat: coord.min(-90).max(90),
            toLon: coord.min(-180).max(180),
          }),
          response: {
            200: z.object({
              distanceKm: z.number(),
              durationMinutes: z.number(),
              geometry: z.unknown().nullable(),
              /** What computed it, in words a dispatcher reads beside the number. */
              source: z.string(),
              routed: z.boolean(),
              asOf: z.iso.datetime(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('dispatch.read', { type: 'dispatch', tenantId: s.tenantId });
        const q = request.query;
        const from = { lat: q.fromLat, lon: q.fromLon };
        const to = { lat: q.toLat, lon: q.toLon };
        const routed = deps.routingUrl
          ? await osrmRoute(doFetch, deps.routingUrl, from, to, deps.timeoutMs ?? 2000)
          : null;
        if (routed)
          return {
            ...routed,
            source:
              'Self-hosted routing on OpenStreetMap roads; closures from live conditions are not applied',
            routed: true,
            asOf: new Date().toISOString(),
          };
        const km = Math.round(straightLineKm(from, to) * 100) / 100;
        return {
          distanceKm: km,
          durationMinutes: Math.round((km / FALLBACK_KMH) * 600) / 10,
          geometry: {
            type: 'LineString',
            coordinates: [
              [from.lon, from.lat],
              [to.lon, to.lat],
            ],
          },
          source: deps.routingUrl
            ? `Straight line at ${FALLBACK_KMH} km/h: the router found no road or did not answer`
            : `Straight line at ${FALLBACK_KMH} km/h: no routing container is running`,
          routed: false,
          asOf: new Date().toISOString(),
        };
      },
    );
  };
