/**
 * The area map on the web build (FLD-13, SCL-13): MapLibre GL JS reading the
 * offline packages kept in Cache Storage through the PMTiles protocol, so it
 * draws with no network. The phone uses MapLibre React Native
 * (area-map.native.tsx) with the same style (@cg/field-core area-map.ts).
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  addProtocol,
  Map as MapLibreMap,
  setWorkerUrl,
  type StyleSpecification,
} from 'maplibre-gl';
import { FileSource, PMTiles, Protocol } from 'pmtiles';
import { useEffect, useRef } from 'react';
import {
  areaMapBounds,
  areaMapStyle,
  type AreaMapJob,
  type AreaMapPackage,
  type Parcel,
  type Point,
} from '@cg/field-core';
import { readMap, type StoredMap } from './maps';

let protocol: Protocol | null = null;
/** MapLibre's worker files ship with the web build (scripts/maplibre-worker.mjs). */
const WORKER = `${process.env['EXPO_BASE_URL'] ?? ''}/maplibre/maplibre-gl-worker.mjs`;

export function AreaMap({
  maps,
  parcels,
  jobs,
  me,
  label,
}: {
  maps: StoredMap[];
  parcels: Parcel[];
  jobs: AreaMapJob[];
  me: Point | null;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let map: MapLibreMap | null = null;
    let alive = true;
    void (async () => {
      if (!protocol) {
        protocol = new Protocol();
        setWorkerUrl(WORKER);
        addProtocol('pmtiles', protocol.tile);
      }
      const packages: AreaMapPackage[] = [];
      for (const m of maps) {
        const blob = await readMap(m);
        if (!blob) continue;
        const name = `area-${m.areaKey}-v${m.version}.pmtiles`;
        protocol.add(new PMTiles(new FileSource(new File([blob], name))));
        packages.push({ areaKey: m.areaKey, url: `pmtiles://${name}`, bounds: m.bounds });
      }
      if (!alive || !box.current) return;
      const input = { packages, parcels, jobs, me };
      const bounds = areaMapBounds(input);
      map = new MapLibreMap({
        container: box.current,
        style: areaMapStyle(input) as unknown as StyleSpecification,
        ...(bounds ? { bounds, fitBoundsOptions: { padding: 24 } } : { center: [0, 0], zoom: 1 }),
        attributionControl: false,
        // The canvas carries the words of what it shows (the page says it again).
        locale: { 'Map.Title': label },
      });
    })();
    return () => {
      alive = false;
      map?.remove();
    };
  }, [maps, parcels, jobs, me, label]);
  return (
    <div
      ref={box}
      data-testid="area-map"
      style={{ width: '100%', height: 360, borderRadius: 8, overflow: 'hidden' }}
    />
  );
}
