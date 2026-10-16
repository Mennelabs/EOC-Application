/**
 * The area map on the phone (FLD-13, SCL-13, ADR-0015): MapLibre React Native
 * opening the offline packages from the app's own files
 * (pmtiles://file://…), so it draws with no signal. Same style as the web
 * build (@cg/field-core area-map.ts). Screen readers get one image named in
 * words; the jobs are listed on Home.
 */
import { Camera, Map, type StyleSpecification } from '@maplibre/maplibre-react-native';
import { View } from 'react-native';
import {
  areaMapBounds,
  areaMapStyle,
  type AreaMapJob,
  type Parcel,
  type Point,
} from '@cg/field-core';
import type { StoredMap } from './maps';

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
  const input = {
    packages: maps.map((m) => ({
      areaKey: m.areaKey,
      url: `pmtiles://${m.uri}`,
      bounds: m.bounds,
    })),
    parcels,
    jobs,
    me,
  };
  const bounds = areaMapBounds(input);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ height: 360, borderRadius: 8, overflow: 'hidden' }}
    >
      <Map
        style={{ flex: 1 }}
        mapStyle={areaMapStyle(input) as unknown as StyleSpecification}
        logo={false}
        attribution={false}
      >
        {bounds ? <Camera initialViewState={{ bounds }} /> : null}
      </Map>
    </View>
  );
}
