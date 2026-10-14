/**
 * CMS Provider Data Catalog (ADR-0039; DCL:DEC-07, the outage log's
 * facility picker): Medicare-certified hospitals and nursing homes in the
 * tenant's counties. Free and public (data.cms.gov). The catalog filters by
 * state abbreviation and county name, so the tenant's county names come
 * from its configuration or its county tenants' names. Hospitals carry no
 * coordinates in this catalog; their geometry stays null until a person
 * places them or a file import adds them.
 * https://data.cms.gov/provider-data/docs
 */
import type { Connector } from '../connector.ts';
import type { RawRow } from '../datasets.ts';
import { stateAbbr } from '../states.ts';

const HOST = 'data.cms.gov';
const PAGE = 500;

interface CmsSource {
  id: string;
  kind: 'hospital' | 'nursing_home';
  row(r: Record<string, unknown>): RawRow;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const point = (lat: unknown, lon: unknown) => {
  const y = Number(lat);
  const x = Number(lon);
  return lat !== '' &&
    lon !== '' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    (x !== 0 || y !== 0)
    ? { type: 'Point', coordinates: [x, y] }
    : null;
};

export const CMS_SOURCES: readonly CmsSource[] = [
  {
    id: 'xubh-q36u', // Hospital General Information
    kind: 'hospital',
    row: (r) => ({
      sourceId: `cms:${String(r['facility_id'] ?? '')}`,
      kind: 'hospital',
      name: str(r['facility_name']) ?? '',
      address: str(r['address']),
      city: str(r['citytown']),
      postal: str(r['zip_code']),
      beds: null,
      geometry: null,
    }),
  },
  {
    id: '4pq5-n9py', // Nursing Home Provider Information
    kind: 'nursing_home',
    row: (r) => {
      const beds = Number(r['number_of_certified_beds']);
      return {
        sourceId: `cms:${String(r['cms_certification_number_ccn'] ?? '')}`,
        kind: 'nursing_home',
        name: str(r['provider_name']) ?? '',
        address: str(r['provider_address']),
        city: str(r['citytown']),
        postal: str(r['zip_code']),
        beds: Number.isInteger(beds) && beds >= 0 ? beds : null,
        geometry: point(r['latitude'], r['longitude']),
      };
    },
  },
];

export function cmsQueryUrl(
  dataset: string,
  state: string,
  county: string,
  offset: number,
): string {
  const u = new URL(`https://${HOST}/provider-data/api/1/datastore/query/${dataset}/0`);
  u.searchParams.set('conditions[0][property]', 'state');
  u.searchParams.set('conditions[0][value]', state);
  u.searchParams.set('conditions[1][property]', 'countyparish');
  u.searchParams.set('conditions[1][value]', county);
  u.searchParams.set('limit', String(PAGE));
  u.searchParams.set('offset', String(offset));
  return u.toString();
}

export const cmsFacilities: Connector = {
  id: 'cms.provider_data.facilities',
  dataset: 'facility',
  title: 'Hospitals and nursing homes (CMS Provider Data Catalog)',
  licence: 'U.S. government work (CMS)',
  hosts: [HOST],
  refreshMs: 30 * 24 * 3600_000,
  requires: ['countyNames'],
  async fetch({ http, scope }) {
    const state = stateAbbr(scope.stateFips);
    const names = scope.countyNames ?? [];
    if (names.length === 0) throw new Error('CMS filters by county name: the tenant has none');
    async function* rows(): AsyncIterable<RawRow> {
      for (const source of CMS_SOURCES)
        for (const county of names)
          for (let offset = 0; ; offset += PAGE) {
            const body = (await http.getJson(cmsQueryUrl(source.id, state, county, offset))) as {
              results?: Record<string, unknown>[];
            };
            const page = body.results ?? [];
            for (const r of page) yield source.row(r);
            if (page.length < PAGE) break;
          }
    }
    return {
      vintage: null,
      sourceUrl: cmsQueryUrl(CMS_SOURCES[0]!.id, state, names[0] ?? '', 0),
      rows: rows(),
    };
  },
};
