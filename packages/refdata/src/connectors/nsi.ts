/**
 * USACE National Structure Inventory (ADR-0039; CON-07, DCL:DEC-06, the
 * joint-assessment sample): one point per structure with its occupancy
 * class, stories, foundation, value and year built. Free and public; the
 * request carries only the county code. Occupancy classes follow Hazus:
 * RES1 single family, RES2 manufactured housing, RES3A–F multi-family,
 * COM/IND/AGR commercial, GOV/EDU/REL public. Unit counts are known only for
 * single-family and manufactured homes (one each); otherwise null (RULE-02).
 * https://www.hec.usace.army.mil/confluence/nsi
 */
import type { Connector } from '../connector.ts';
import type { RawRow } from '../datasets.ts';

const HOST = 'nsi.sec.usace.army.mil';

const FOUNDATIONS: Record<string, string> = {
  B: 'basement',
  C: 'crawl space',
  F: 'fill',
  I: 'pile',
  P: 'pier',
  S: 'slab',
  W: 'solid wall',
};

export function homeTypeOf(occtype: string): {
  homeType: 'single_family' | 'multi_family' | 'manufactured' | 'commercial' | 'public' | 'other';
  units: number | null;
} {
  const o = occtype.toUpperCase();
  if (o.startsWith('RES1')) return { homeType: 'single_family', units: 1 };
  if (o.startsWith('RES2')) return { homeType: 'manufactured', units: 1 };
  if (o.startsWith('RES3')) return { homeType: 'multi_family', units: null };
  if (/^(COM|IND|AGR)/.test(o)) return { homeType: 'commercial', units: null };
  if (/^(GOV|EDU|REL)/.test(o)) return { homeType: 'public', units: null };
  return { homeType: 'other', units: null };
}

interface NsiFeature {
  geometry?: { type?: string; coordinates?: number[] } | null;
  properties?: Record<string, unknown> | null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

export function nsiStructureRow(f: NsiFeature): RawRow {
  const p = f.properties ?? {};
  const occtype = typeof p['occtype'] === 'string' ? p['occtype'] : '';
  const { homeType, units } = homeTypeOf(occtype);
  const coords =
    f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates)
      ? f.geometry.coordinates.slice(0, 2)
      : [p['x'], p['y']];
  const cb = typeof p['cbfips'] === 'string' ? p['cbfips'] : '';
  const year = num(p['med_yr_blt']);
  return {
    sourceId: String(p['fd_id'] ?? p['bid'] ?? ''),
    geometry: { type: 'Point', coordinates: coords },
    occupancy: occtype || null,
    homeType,
    units,
    stories: num(p['num_story']),
    foundation: FOUNDATIONS[String(p['found_type'] ?? '')] ?? null,
    valueUsd: num(p['val_struct']),
    yearBuilt: year !== null && year >= 1600 ? Math.round(year) : null,
    tractGeoid: /^[0-9]{11}/.test(cb) ? cb.slice(0, 11) : null,
  };
}

export const nsiStructures: Connector = {
  id: 'usace.nsi.structures',
  dataset: 'structure',
  title: 'Structures (USACE National Structure Inventory)',
  licence: 'U.S. government work (USACE NSI)',
  hosts: [HOST],
  refreshMs: 90 * 24 * 3600_000,
  async fetch({ http, scope }) {
    const url = (county: string) => {
      const u = new URL(`https://${HOST}/nsiapi/structures`);
      u.searchParams.set('fips', county);
      u.searchParams.set('fmt', 'fc');
      return u.toString();
    };
    async function* rows(): AsyncIterable<RawRow> {
      for (const county of scope.countyFips) {
        const fc = (await http.getJson(url(county))) as { features?: NsiFeature[] };
        for (const f of fc.features ?? []) yield nsiStructureRow(f);
      }
    }
    return { vintage: null, sourceUrl: url(scope.countyFips[0] ?? ''), rows: rows() };
  },
};
