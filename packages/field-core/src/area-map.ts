/**
 * The field map's style (FLD-13, SCL-13, ADR-0015): the area's offline map
 * packages drawn as the console draws the county tiles (same colours, no
 * labels, so nothing needs fonts offline), with the area's lots, the jobs
 * and the volunteer's own position on top. One style for the phone (MapLibre
 * React Native) and the web build (MapLibre GL JS). The map is never the only
 * way to a job: the screen says in words what it shows, and the jobs list
 * stays one tap away (FR-00.09, AC-03C).
 */
import type { Parcel, Point } from './geo.ts';

export interface AreaMapPackage {
  areaKey: string;
  /** What MapLibre opens: pmtiles://file://… on the phone, pmtiles://<name> on the web. */
  url: string;
  bounds: [number, number, number, number];
}

export interface AreaMapJob {
  id: string;
  reference: string;
  position: Point;
}

export interface AreaMapInput {
  packages: AreaMapPackage[];
  parcels: Parcel[];
  jobs: AreaMapJob[];
  me: Point | null;
}

type Feature = {
  type: 'Feature';
  id?: string;
  properties: Record<string, string>;
  geometry: unknown;
};
const collection = (features: Feature[]) => ({ type: 'FeatureCollection', features });

/** The basemap layers of one package, as the console's county map draws them. */
function basemapLayers(source: string): Record<string, unknown>[] {
  const fill = (id: string, layer: string, paint: Record<string, unknown>, minzoom?: number) => ({
    id: `${source}-${id}`,
    type: 'fill',
    source,
    'source-layer': layer,
    ...(minzoom !== undefined ? { minzoom } : {}),
    paint,
  });
  return [
    fill('landuse', 'landuse', { 'fill-color': '#e6e9dc', 'fill-opacity': 0.6 }),
    fill('park', 'park', { 'fill-color': '#d7ead3', 'fill-opacity': 0.7 }),
    fill('water', 'water', { 'fill-color': '#bcd4e6' }),
    {
      id: `${source}-waterway`,
      type: 'line',
      source,
      'source-layer': 'waterway',
      paint: { 'line-color': '#9cbcd6', 'line-width': 1 },
    },
    fill('building', 'building', { 'fill-color': '#d9d4cb' }, 13),
    {
      id: `${source}-road-minor`,
      type: 'line',
      source,
      'source-layer': 'transportation',
      filter: ['in', 'class', 'minor', 'service', 'track', 'path'],
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 3],
      },
    },
    {
      id: `${source}-road-major`,
      type: 'line',
      source,
      'source-layer': 'transportation',
      filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary'],
      paint: {
        'line-color': '#f2c66d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 6],
      },
    },
  ];
}

/** The map's style: one source per package, the lots, the jobs and the volunteer. */
export function areaMapStyle(i: AreaMapInput): Record<string, unknown> {
  const sources: Record<string, unknown> = {};
  const layers: Record<string, unknown>[] = [
    { id: 'background', type: 'background', paint: { 'background-color': '#f3f1ec' } },
  ];
  i.packages.forEach((p, n) => {
    const source = `area${n}`;
    sources[source] = {
      type: 'vector',
      url: p.url,
      attribution: '© OpenStreetMap contributors',
    };
    layers.push(...basemapLayers(source));
  });
  sources['lots'] = {
    type: 'geojson',
    data: collection(
      i.parcels
        .filter((p) => p.geometry)
        .map((p) => ({
          type: 'Feature',
          id: p.id,
          properties: { address: p.line1 ?? '' },
          geometry: p.geometry,
        })),
    ),
  };
  sources['jobs'] = {
    type: 'geojson',
    data: collection(
      i.jobs.map((j) => ({
        type: 'Feature',
        id: j.id,
        properties: { reference: j.reference },
        geometry: { type: 'Point', coordinates: [j.position.lon, j.position.lat] },
      })),
    ),
  };
  sources['me'] = {
    type: 'geojson',
    data: collection(
      i.me
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: [i.me.lon, i.me.lat] },
            },
          ]
        : [],
    ),
  };
  layers.push(
    {
      id: 'lots-fill',
      type: 'fill',
      source: 'lots',
      paint: { 'fill-color': '#1d4f91', 'fill-opacity': 0.08 },
    },
    {
      id: 'lots-line',
      type: 'line',
      source: 'lots',
      paint: { 'line-color': '#1d4f91', 'line-width': 1 },
    },
    // Jobs: a dark ring around a light centre, so they read on any background (WCAG 1.4.11).
    {
      id: 'jobs',
      type: 'circle',
      source: 'jobs',
      paint: {
        'circle-radius': 9,
        'circle-color': '#ffd166',
        'circle-stroke-color': '#1b1b1b',
        'circle-stroke-width': 3,
      },
    },
    {
      id: 'me',
      type: 'circle',
      source: 'me',
      paint: {
        'circle-radius': 7,
        'circle-color': '#0b6bcb',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    },
  );
  return { version: 8, sources, layers };
}

/** The box the map opens on: the packages' boxes, else the jobs and lots, else null. */
export function areaMapBounds(i: AreaMapInput): [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of i.packages) {
    xs.push(p.bounds[0], p.bounds[2]);
    ys.push(p.bounds[1], p.bounds[3]);
  }
  if (!xs.length) {
    for (const j of i.jobs) {
      xs.push(j.position.lon);
      ys.push(j.position.lat);
    }
    for (const p of i.parcels)
      if (p.centroid) {
        xs.push(p.centroid.lon);
        ys.push(p.centroid.lat);
      }
    if (i.me) {
      xs.push(i.me.lon);
      ys.push(i.me.lat);
    }
  }
  if (!xs.length) return null;
  const pad = xs.length === 1 ? 0.003 : 0;
  return [
    Math.min(...xs) - pad,
    Math.min(...ys) - pad,
    Math.max(...xs) + pad,
    Math.max(...ys) + pad,
  ];
}
