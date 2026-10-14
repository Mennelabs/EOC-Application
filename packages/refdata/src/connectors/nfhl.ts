/**
 * FEMA National Flood Hazard Layer (ADR-0039; the narrative's "in a special
 * flood hazard area", a map layer): flood hazard zones intersecting the
 * county's outline. Free and public; the request carries only the bounding
 * box, so the tenant needs its tracts (or an imported outline) first.
 * https://hazards.fema.gov/femaportal/wps/portal/NFHLWMS
 */
import type { Connector } from '../connector.ts';
import type { RawRow } from '../datasets.ts';
import { arcgisFeatures, arcgisQueryUrl, type ArcgisFeature } from './arcgis.ts';

const HOST = 'hazards.fema.gov';
const ZONES_LAYER = `https://${HOST}/arcgis/rest/services/public/NFHL/MapServer/28`;

export function floodZoneRow(f: ArcgisFeature): RawRow {
  const p = f.properties ?? {};
  const zone = String(p['FLD_ZONE'] ?? '').trim();
  const subtype = typeof p['ZONE_SUBTY'] === 'string' ? p['ZONE_SUBTY'].trim() : '';
  const bfe =
    typeof p['STATIC_BFE'] === 'number' && p['STATIC_BFE'] > -9000 ? p['STATIC_BFE'] : null;
  return {
    zone: subtype ? `${zone} (${subtype.toLowerCase()})` : zone,
    specialHazard: p['SFHA_TF'] === 'T',
    baseFloodElevation: bfe,
    geometry: f.geometry,
  };
}

export const nfhlFloodZones: Connector = {
  id: 'fema.nfhl.flood_zones',
  dataset: 'flood_zone',
  title: 'Flood hazard zones (FEMA National Flood Hazard Layer)',
  licence: 'U.S. government work (FEMA NFHL)',
  hosts: [HOST],
  refreshMs: 30 * 24 * 3600_000,
  requires: ['bbox'],
  async fetch({ http, scope }) {
    if (!scope.bbox)
      throw new Error('flood zones need the county outline: pull or import tracts first');
    const params = {
      where: '1=1',
      geometry: scope.bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE',
      returnGeometry: 'true',
    };
    async function* rows(): AsyncIterable<RawRow> {
      for await (const f of arcgisFeatures(http, ZONES_LAYER, params)) yield floodZoneRow(f);
    }
    return {
      vintage: 'NFHL current',
      sourceUrl: arcgisQueryUrl(ZONES_LAYER, params, 0, 1000),
      rows: rows(),
    };
  },
};
