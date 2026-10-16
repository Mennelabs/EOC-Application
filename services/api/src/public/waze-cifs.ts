/**
 * Road closures as a Waze for Cities feed (FL:FR-05 "one-tap road status that
 * also updates Waze"; CON-14; Q-04: "adapter + file stand-in; staff entry
 * fallback"). Waze for Cities partners publish a Closure and Incident Feed
 * (CIFS) that Waze reads on its own schedule; there is no push. This builds
 * that feed from the county's road reports: each road reported closed or
 * impassable is a road closure, and one down to one lane is a lane-closed
 * hazard, in both directions, from when it was reported until it is cleared.
 * A closure needs a line along the road (at least two points); a road drawn as
 * a single point is left out and named back to staff, never guessed. The
 * field names follow the CIFS JSON format and are to be checked against
 * Waze's specification when the county enrols.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';

export interface RoadClosure {
  id: string;
  name: string;
  status: 'closed' | 'impassable' | 'one_lane';
  reason: string | null;
  reportedAt: Date;
  /** The road's line as [lat, lon] points; empty or one point when only a point is known. */
  line: [number, number][];
}

export interface CifsIncident {
  id: string;
  type: 'ROAD_CLOSED' | 'HAZARD';
  subtype: 'ROAD_CLOSED_HAZARD' | 'HAZARD_ON_ROAD_LANE_CLOSED';
  polyline: string;
  street: string;
  direction: 'BOTH_DIRECTIONS';
  starttime: string;
  description: string;
}

/** A point as CIFS writes it: latitude then longitude, six decimals. */
const point = ([lat, lon]: [number, number]) => `${lat.toFixed(6)} ${lon.toFixed(6)}`;

export function cifsFeed(closures: readonly RoadClosure[]): {
  feed: { incidents: CifsIncident[] };
  leftOut: { id: string; name: string; reason: string }[];
} {
  const incidents: CifsIncident[] = [];
  const leftOut: { id: string; name: string; reason: string }[] = [];
  for (const c of closures) {
    if (c.line.length < 2) {
      leftOut.push({ id: c.id, name: c.name, reason: 'drawn as a point; Waze needs a line' });
      continue;
    }
    const lane = c.status === 'one_lane';
    incidents.push({
      id: `cg-${c.id}`,
      type: lane ? 'HAZARD' : 'ROAD_CLOSED',
      subtype: lane ? 'HAZARD_ON_ROAD_LANE_CLOSED' : 'ROAD_CLOSED_HAZARD',
      polyline: c.line.map(point).join(' '),
      street: c.name,
      direction: 'BOTH_DIRECTIONS',
      starttime: c.reportedAt.toISOString(),
      description: [lane ? 'One lane open' : 'Road closed', c.reason].filter(Boolean).join(': '),
    });
  }
  return { feed: { incidents }, leftOut };
}

/** The [lat, lon] points of a GeoJSON line (the first line of a multi-line); none for a point. */
export function lineOf(geojson: string | null): [number, number][] {
  if (!geojson) return [];
  try {
    const g = JSON.parse(geojson) as { type: string; coordinates: unknown };
    const coords =
      g.type === 'LineString'
        ? (g.coordinates as [number, number][])
        : g.type === 'MultiLineString'
          ? ((g.coordinates as [number, number][][])[0] ?? [])
          : [];
    return coords.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}

/**
 * The roads closed or down to one lane now: the latest report for each road of each open
 * event, not cleared. Runs under the caller's tenant (row-level security).
 */
export async function currentClosures(trx: Transaction<Database>): Promise<RoadClosure[]> {
  const rows = await trx
    .selectFrom('cg.road_status as r')
    .innerJoin('cg.event as e', 'e.id', 'r.event_id')
    .select([
      'r.id',
      'r.name',
      'r.status',
      'r.reason',
      'r.reported_at',
      'r.cleared_at',
      sql<string | null>`ST_AsGeoJSON(r.geom, 6)`.as('geojson'),
    ])
    .distinctOn(['r.event_id', 'r.name'])
    .where('e.status', '=', 'active')
    .orderBy('r.event_id')
    .orderBy('r.name')
    .orderBy('r.reported_at', 'desc')
    .execute();
  return rows
    .filter(
      (r): r is typeof r & { status: RoadClosure['status'] } =>
        ['closed', 'impassable', 'one_lane'].includes(r.status) && !r.cleared_at,
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      reason: r.reason,
      reportedAt: new Date(r.reported_at),
      line: lineOf(r.geojson),
    }));
}
