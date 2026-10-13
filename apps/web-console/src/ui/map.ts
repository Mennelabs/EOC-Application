/**
 * The console's map (CON-03, DSP-01, SCL-13, ADR-0029): MapLibre over the
 * county's own vector tiles, loaded only when someone opens it; every layer
 * also has a list, which stays the primary view (AC-03C, ACC-07). Markers are
 * buttons with a text name, a shape and an outline as well as a colour, so
 * nothing depends on colour alone (WCAG 1.4.1). Without tiles the markers
 * still show over a plain background (SCL-06).
 */
import {
  addProtocol,
  setWorkerUrl,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type ErrorEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
// MapLibre 6 loads its worker from beside its own bundle; Vite bundles the worker and gives its URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

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

export interface MapPoint {
  id: string;
  lat: number;
  lon: number;
  /** Read aloud and shown on hover: what it is and its state. */
  label: string;
  /** A short visible mark (a letter or two) so the shape is not the only cue. */
  mark: string;
  shape: 'circle' | 'square' | 'diamond' | 'triangle';
  tone: 'ok' | 'busy' | 'warn' | 'danger' | 'info';
  layer: string;
}

export interface ConsoleMap {
  setPoints(points: MapPoint[], visibleLayers: ReadonlySet<string>): void;
  /** The event's area (GeoJSON), outlined; null removes it. */
  setArea(geojson: unknown): void;
  destroy(): void;
}

export function openMap(
  container: HTMLElement,
  onPick: (p: MapPoint) => void,
  center: { lat: number; lon: number } = { lat: 38.8, lon: -90.85 },
): ConsoleMap {
  if (!protocolAdded) {
    setWorkerUrl(workerUrl);
    addProtocol('pmtiles', new Protocol().tile);
    protocolAdded = true;
  }
  container.textContent = '';
  const map = new MapLibreMap({
    container,
    style: STYLE(`${location.origin}/tiles/region.pmtiles`),
    center: [center.lon, center.lat],
    zoom: 11,
    attributionControl: { customAttribution: '© OpenStreetMap contributors' },
  });
  map.addControl(new NavigationControl({ showCompass: false }));
  map.on('error', (e: ErrorEvent) => {
    if (String(e.error?.message ?? '').includes('pmtiles')) container.classList.add('no-tiles');
  });
  let markers: Marker[] = [];
  let fitted = false;
  return {
    setPoints(points, visible) {
      for (const m of markers) m.remove();
      markers = [];
      const bounds = new LngLatBounds();
      for (const p of points) {
        if (!visible.has(p.layer)) continue;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `marker shape-${p.shape} tone-${p.tone}`;
        el.setAttribute('aria-label', p.label);
        el.title = p.label;
        el.textContent = p.mark;
        el.addEventListener('click', () => onPick(p));
        markers.push(new Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
        bounds.extend([p.lon, p.lat]);
      }
      if (!fitted && markers.length) {
        map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
        fitted = true;
      }
    },
    setArea(geojson) {
      const apply = () => {
        if (map.getLayer('area-line')) map.removeLayer('area-line');
        if (map.getSource('area')) map.removeSource('area');
        if (!geojson) return;
        map.addSource('area', { type: 'geojson', data: geojson as never });
        map.addLayer({
          id: 'area-line',
          type: 'line',
          source: 'area',
          paint: { 'line-color': '#6b2fd6', 'line-width': 3, 'line-dasharray': [2, 1] },
        });
      };
      if (map.isStyleLoaded()) apply();
      else map.once('load', apply);
    },
    destroy() {
      map.remove();
    },
  };
}
