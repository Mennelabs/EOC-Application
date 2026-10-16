/** FLD-13, SCL-13: the field map draws each offline package as the console draws the county tiles, with the lots, jobs and the volunteer on top. */
import { describe, expect, it } from 'vitest';
import { areaMapBounds, areaMapStyle, type AreaMapInput } from '../src/area-map.ts';

const input: AreaMapInput = {
  packages: [
    {
      areaKey: 'north',
      url: 'pmtiles://file:///maps/north.pmtiles',
      bounds: [-90.9, 38.8, -90.8, 38.85],
    },
    {
      areaKey: 'south',
      url: 'pmtiles://file:///maps/south.pmtiles',
      bounds: [-90.95, 38.7, -90.85, 38.78],
    },
  ],
  parcels: [
    {
      id: 'p1',
      parcelId: 'SYN-1',
      line1: '100 Hickory Way',
      city: 'Harmon City',
      postal: null,
      structure: 'single_family',
      unitCount: null,
      areaKey: 'north',
      centroid: { lat: 38.81, lon: -90.87 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-90.87, 38.81],
            [-90.869, 38.81],
            [-90.869, 38.811],
            [-90.87, 38.81],
          ],
        ],
      },
    },
    {
      id: 'p2',
      parcelId: 'SYN-2',
      line1: null,
      city: null,
      postal: null,
      structure: 'unknown',
      unitCount: null,
      areaKey: 'north',
      centroid: null,
      geometry: null,
    },
  ],
  jobs: [{ id: 'j1', reference: 'M-00012', position: { lat: 38.812, lon: -90.868 } }],
  me: { lat: 38.8125, lon: -90.8675 },
};

describe('the field map style (FLD-13, SCL-13)', () => {
  it('one vector source per package, with the console colours and no text (no fonts offline)', () => {
    const style = areaMapStyle(input) as {
      sources: Record<string, { type: string; url?: string; data?: { features: unknown[] } }>;
      layers: { id: string; type: string; source?: string }[];
    };
    expect(style.sources['area0']).toMatchObject({ type: 'vector', url: input.packages[0]!.url });
    expect(style.sources['area1']).toMatchObject({ type: 'vector', url: input.packages[1]!.url });
    expect(style.layers.filter((l) => l.source === 'area0').map((l) => l.id)).toContain(
      'area0-road-major',
    );
    expect(style.layers.some((l) => l.type === 'symbol')).toBe(false);
    // The lots with an outline, the job and the volunteer, drawn last.
    expect(style.sources['lots']!.data!.features).toHaveLength(1);
    expect(style.sources['jobs']!.data!.features).toHaveLength(1);
    expect(style.sources['me']!.data!.features).toHaveLength(1);
    expect(style.layers.slice(-4).map((l) => l.id)).toEqual([
      'lots-fill',
      'lots-line',
      'jobs',
      'me',
    ]);
  });

  it('without a package the map still draws the lots and jobs on a plain background', () => {
    const style = areaMapStyle({ ...input, packages: [] }) as { sources: Record<string, unknown> };
    expect(Object.keys(style.sources).sort()).toEqual(['jobs', 'lots', 'me']);
  });

  it('opens on the packages, else on the jobs, lots and the volunteer', () => {
    expect(areaMapBounds(input)).toEqual([-90.95, 38.7, -90.8, 38.85]);
    const b = areaMapBounds({ ...input, packages: [] })!;
    expect(b[0]).toBeCloseTo(-90.87, 6);
    expect(b[3]).toBeCloseTo(38.8125, 6);
    expect(areaMapBounds({ packages: [], parcels: [], jobs: [], me: null })).toBeNull();
  });
});
