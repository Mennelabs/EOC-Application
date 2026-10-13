/**
 * Optional map (PUB-07, SCL-13, ADR-0029): MapLibre over the county's own
 * vector tiles (PMTiles served by the gateway at /tiles). Loaded only when a
 * visitor asks; the list stays the primary view. No labels until a glyph set
 * is self-hosted; site markers are DOM elements the screen reader can read.
 */
import {
  addProtocol,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type ErrorEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { Site } from './main.ts';
import { strings, type Lang } from './i18n.ts';

let protocolAdded = false;

const STYLE = (tiles: string): StyleSpecification => ({
  version: 8,
  sources: { osm: { type: 'vector', url: `pmtiles://${tiles}` } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f3f1ec' } },
    {
      id: 'landuse',
      type: 'fill',
      source: 'osm',
      'source-layer': 'landuse',
      paint: { 'fill-color': '#e6e9dc', 'fill-opacity': 0.6 },
    },
    {
      id: 'park',
      type: 'fill',
      source: 'osm',
      'source-layer': 'park',
      paint: { 'fill-color': '#d7ead3', 'fill-opacity': 0.7 },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'osm',
      'source-layer': 'water',
      paint: { 'fill-color': '#bcd4e6' },
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'osm',
      'source-layer': 'waterway',
      paint: { 'line-color': '#9cbcd6', 'line-width': 1 },
    },
    {
      id: 'building',
      type: 'fill',
      source: 'osm',
      'source-layer': 'building',
      minzoom: 13,
      paint: { 'fill-color': '#d9d4cb' },
    },
    {
      id: 'road-minor',
      type: 'line',
      source: 'osm',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'minor', 'service', 'track', 'path'],
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 3],
      },
    },
    {
      id: 'road-major',
      type: 'line',
      source: 'osm',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary'],
      paint: {
        'line-color': '#f2c66d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 6],
      },
    },
  ],
});

export async function showMap(container: HTMLElement, sites: Site[], lang: Lang): Promise<void> {
  const t = strings(lang);
  if (!protocolAdded) {
    addProtocol('pmtiles', new Protocol().tile);
    protocolAdded = true;
  }
  container.textContent = '';
  const positioned = sites.filter((s) => s.position);
  const first = positioned[0]?.position ?? { lat: 38.8, lon: -90.85 };
  const map = new MapLibreMap({
    container,
    style: STYLE(`${location.origin}/tiles/region.pmtiles`),
    center: [first.lon, first.lat],
    zoom: 11,
    attributionControl: { customAttribution: '© OpenStreetMap contributors' },
  });
  map.addControl(new NavigationControl({ showCompass: false }));
  map.on('error', (e: ErrorEvent) => {
    // Tiles are optional (the maps profile); markers still show over the base colour (SCL-06).
    if (String(e.error?.message ?? '').includes('pmtiles'))
      map.getContainer().classList.add('no-tiles');
  });
  const bounds = new LngLatBounds();
  for (const s of positioned) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `marker marker-${s.status}`;
    dot.setAttribute('aria-label', `${s.name}: ${t.status[s.status] ?? s.status}`);
    dot.addEventListener('click', () =>
      document
        .getElementById(`site-${s.slug}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
    new Marker({ element: dot }).setLngLat([s.position!.lon, s.position!.lat]).addTo(map);
    bounds.extend([s.position!.lon, s.position!.lat]);
  }
  if (positioned.length > 1) map.fitBounds(bounds, { padding: 40, maxZoom: 13 });
}
