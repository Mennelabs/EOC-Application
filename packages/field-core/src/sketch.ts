/**
 * FLD-04: a sketch of the lot for "Is this the property?": the parcel's
 * outline from the area package, the outlines of its neighbours around it and
 * the pin, projected into a small frame the phone draws as vector paths. No
 * map tiles and no map library are needed, so it works offline with only the
 * area package. A pin far from the lot is left out of the frame (the screen
 * says the distance in words instead).
 */
import { distanceM, type Parcel, type Point, type Ring } from './geo.ts';

export interface Sketch {
  width: number;
  height: number;
  /** SVG path data for the lot's outline (each polygon's outer ring). */
  lot: string;
  /** Neighbouring lots inside the frame, at most 40. */
  neighbours: string[];
  /** The pin in frame coordinates; null when it is not known or too far to show. */
  pin: { x: number; y: number } | null;
}

/** Beyond this the pin is not drawn: the frame would shrink the lot to a dot. */
export const SKETCH_PIN_MAX_M = 150;

const outerRings = (p: Parcel): Ring[] => {
  const g = p.geometry;
  if (!g) return [];
  return g.type === 'Polygon' ? [g.coordinates[0] ?? []] : g.coordinates.map((r) => r[0] ?? []);
};

export function parcelSketch(
  parcel: Parcel,
  others: readonly Parcel[],
  pin: Point | null,
  size: { width: number; height: number } = { width: 280, height: 200 },
  pad = 12,
): Sketch | null {
  const rings = outerRings(parcel).filter((r) => r.length >= 3);
  if (!rings.length) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const take = (lon: number, lat: number) => {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  };
  for (const r of rings) for (const [lon, lat] of r) take(lon, lat);
  const centre = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  const showPin = pin && distanceM(pin, centre) <= SKETCH_PIN_MAX_M ? pin : null;
  if (showPin) take(showPin.lon, showPin.lat);
  // Room around the lot for its neighbours.
  const marginLon = Math.max((maxLon - minLon) * 0.35, 0.0001);
  const marginLat = Math.max((maxLat - minLat) * 0.35, 0.0001);
  minLon -= marginLon;
  maxLon += marginLon;
  minLat -= marginLat;
  maxLat += marginLat;
  const kx = Math.cos((centre.lat * Math.PI) / 180);
  const spanX = (maxLon - minLon) * kx;
  const spanY = maxLat - minLat;
  const scale = Math.min((size.width - 2 * pad) / spanX, (size.height - 2 * pad) / spanY);
  const offX = (size.width - spanX * scale) / 2;
  const offY = (size.height - spanY * scale) / 2;
  const xy = (lon: number, lat: number) => ({
    x: Math.round((offX + (lon - minLon) * kx * scale) * 10) / 10,
    y: Math.round((offY + (maxLat - lat) * scale) * 10) / 10,
  });
  const path = (rs: Ring[]) =>
    rs
      .map(
        (r) =>
          r
            .map(([lon, lat], i) => {
              const p = xy(lon, lat);
              return `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`;
            })
            .join(' ') + ' Z',
      )
      .join(' ');
  const inFrame = (r: Ring) =>
    r.some(([lon, lat]) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat);
  const neighbours = others
    .filter((o) => o.parcelId !== parcel.parcelId)
    .map((o) => outerRings(o).filter((r) => r.length >= 3 && inFrame(r)))
    .filter((rs) => rs.length > 0)
    .slice(0, 40)
    .map(path);
  return {
    width: size.width,
    height: size.height,
    lot: path(rings),
    neighbours,
    pin: showPin ? xy(showPin.lon, showPin.lat) : null,
  };
}
