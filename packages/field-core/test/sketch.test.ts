/**
 * FLD-04: the sketch of the lot on "Is this the property?": the outline fills
 * the frame with room for its neighbours, north is up and east is right, the
 * pin is drawn where the person stands, a far pin or a lot without an outline
 * gives no sketch to mislead.
 */
import { describe, expect, it } from 'vitest';
import { parcelSketch, type Parcel } from '../src/index.ts';

const lot = (parcelId: string, lon: number, lat: number, d = 0.0003): Parcel => ({
  id: parcelId,
  parcelId,
  line1: `${parcelId} Exercise Way`,
  city: 'Harmon City',
  postal: '63002',
  structure: 'single_family',
  unitCount: 1,
  areaKey: 'cedar-ridge',
  centroid: { lat: lat + d / 2, lon: lon + d / 2 },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + d, lat],
        [lon + d, lat + d],
        [lon, lat + d],
        [lon, lat],
      ],
    ],
  },
});

const points = (d: string) =>
  [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

describe('parcel sketch', () => {
  const home = lot('104', -90.87, 38.79);
  const east = lot('106', -90.8697, 38.79);
  const far = lot('900', -90.8, 38.7);

  it('FLD-04: the lot is drawn inside the frame, north up and east right, with its neighbour and not a distant lot', () => {
    const s = parcelSketch(home, [home, east, far], { lat: 38.79015, lon: -90.86985 })!;
    expect(s).not.toBeNull();
    const pts = points(s.lot);
    expect(pts).toHaveLength(5);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(280);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(200);
    }
    // Ring order: SW, SE, NE: east is to the right, north is up.
    expect(pts[1]!.x).toBeGreaterThan(pts[0]!.x);
    expect(pts[2]!.y).toBeLessThan(pts[1]!.y);
    expect(s.lot.endsWith('Z')).toBe(true);
    expect(s.neighbours).toHaveLength(1);
    // The pin in the middle of the lot is drawn inside its outline.
    expect(s.pin!.x).toBeGreaterThan(pts[0]!.x);
    expect(s.pin!.x).toBeLessThan(pts[1]!.x);
    expect(s.pin!.y).toBeLessThan(pts[0]!.y);
    expect(s.pin!.y).toBeGreaterThan(pts[2]!.y);
  });

  it('FLD-04: a pin far from the lot is not drawn; a lot without an outline has no sketch', () => {
    expect(parcelSketch(home, [], { lat: 38.8, lon: -90.87 })!.pin).toBeNull();
    expect(parcelSketch(home, [], null)!.pin).toBeNull();
    expect(parcelSketch({ ...home, geometry: null }, [], null)).toBeNull();
  });
});
