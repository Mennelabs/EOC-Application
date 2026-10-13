/**
 * Small geometry for the phone (FLD-04, FLD-05, FLD-10, FLD-16): distance,
 * point in polygon, parcel snapping, hazard-area warnings. No map library;
 * parcels are GeoJSON polygons from the area package.
 */

export interface Point {
  lat: number;
  lon: number;
}

/** GeoJSON polygon ring: [lon, lat] pairs, closed. */
export type Ring = [number, number][];

export interface Parcel {
  id: string;
  parcelId: string;
  line1: string | null;
  city: string | null;
  postal: string | null;
  structure: string;
  unitCount: number | null;
  areaKey: string | null;
  centroid: Point | null;
  /** GeoJSON Polygon or MultiPolygon geometry, when the package carried outlines. */
  geometry?:
    | { type: 'Polygon'; coordinates: Ring[] }
    | { type: 'MultiPolygon'; coordinates: Ring[][] }
    | null;
}

export function distanceM(a: Point, b: Point): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting; a point on the edge counts as inside. */
export function pointInRing(p: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi === p.lat && xi === p.lon) return true;
    const crosses =
      yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInParcel(p: Point, parcel: Parcel): boolean {
  const g = parcel.geometry;
  if (!g) return false;
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polygons.some((rings) => {
    const [outer, ...holes] = rings;
    return !!outer && pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h));
  });
}

/** Distance from a point to the parcel: zero inside, else to the nearest ring vertex or edge midpoint (good enough for a 30–120 m lot). */
export function distanceToParcelM(p: Point, parcel: Parcel): number {
  if (pointInParcel(p, parcel)) return 0;
  const g = parcel.geometry;
  if (!g) return parcel.centroid ? distanceM(p, parcel.centroid) : Number.POSITIVE_INFINITY;
  const rings = g.type === 'Polygon' ? [g.coordinates[0]!] : g.coordinates.map((r) => r[0]!);
  let best = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[i + 1]!;
      best = Math.min(
        best,
        distanceM(p, { lat: y1, lon: x1 }),
        distanceM(p, { lat: (y1 + y2) / 2, lon: (x1 + x2) / 2 }),
      );
    }
  }
  return best;
}

export interface Snap {
  parcel: Parcel;
  /** Zero when the fix is inside the parcel outline. */
  distanceM: number;
  inside: boolean;
  /** FLD-04: the question the screen asks; a far or ambiguous snap asks harder. */
  confidence: 'inside' | 'near' | 'far';
  /** Other candidates within range, nearest first, for "Pick another lot". */
  alternatives: { parcel: Parcel; distanceM: number }[];
}

/**
 * FLD-04: drop the fix on the parcel that contains it, else the nearest one
 * within `maxM` (default 60 m, about the width of two suburban lots); a fix
 * with a poor accuracy radius widens the search. Null when no parcel is near
 * enough: the screen offers a landmark note instead (FLD-05).
 */
export function snapToParcel(
  fix: Point & { accuracyM?: number | null },
  parcels: readonly Parcel[],
  opts: { maxM?: number; alternatives?: number } = {},
): Snap | null {
  const maxM = Math.max(opts.maxM ?? 60, Math.min(200, fix.accuracyM ?? 0));
  const scored = parcels
    .map((parcel) => ({ parcel, distanceM: distanceToParcelM(fix, parcel) }))
    .filter((s) => s.distanceM <= maxM)
    .sort((a, b) => a.distanceM - b.distanceM);
  const best = scored[0];
  if (!best) return null;
  const inside = best.distanceM === 0;
  return {
    parcel: best.parcel,
    distanceM: Math.round(best.distanceM * 10) / 10,
    inside,
    confidence: inside ? 'inside' : best.distanceM <= 20 ? 'near' : 'far',
    alternatives: scored
      .slice(1, 1 + (opts.alternatives ?? 4))
      .map((s) => ({ ...s, distanceM: Math.round(s.distanceM * 10) / 10 })),
  };
}

export interface HazardArea {
  id: string;
  kind: string;
  severity: string;
  state: string;
  position: Point | null;
  radiusM: number | null;
  summary: string | null;
}

/** FLD-16, DSP-07: the hazards whose area the position is inside or about to enter (within `marginM`). */
export function hazardsAround(
  p: Point,
  hazards: readonly HazardArea[],
  marginM = 30,
): { hazard: HazardArea; distanceM: number; inside: boolean }[] {
  const out: { hazard: HazardArea; distanceM: number; inside: boolean }[] = [];
  for (const h of hazards) {
    if (!h.position || h.state === 'cleared') continue;
    const radius = h.radiusM ?? 50;
    const d = distanceM(p, h.position);
    if (d <= radius + marginM)
      out.push({ hazard: h, distanceM: Math.round(d), inside: d <= radius });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}
