/**
 * Census Bureau sources (ADR-0039; DCL:DEC-05/06, EQ-11): census tracts
 * from TIGERweb, and each tract's population profile from the American
 * Community Survey 5-year detailed tables through the Census Data API.
 * Free; the Data API takes a free key (a secret, optional at low volume).
 * Requests carry only the state and county codes. Estimates keep their
 * margins of error; a suppressed or unavailable estimate is null (RULE-02).
 * https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_restmapservice.html
 * https://www.census.gov/data/developers/data-sets/acs-5year.html
 */
import type { Connector } from '../connector.ts';
import type { RawRow } from '../datasets.ts';
import { arcgisFeatures, arcgisQueryUrl } from './arcgis.ts';

const TIGERWEB = 'tigerweb.geo.census.gov';
const DATA_API = 'api.census.gov';
const TRACTS_LAYER = `https://${TIGERWEB}/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0`;

/** The latest 5-year release when this was written: ACS 2020–2024 (December 2025). */
export const ACS_YEAR = 2024;

export const tigerwebTracts: Connector = {
  id: 'census.tigerweb.tracts',
  dataset: 'tract',
  title: 'Census tracts (Census Bureau TIGERweb)',
  licence: 'U.S. government work (Census Bureau TIGER/Line)',
  hosts: [TIGERWEB],
  refreshMs: 90 * 24 * 3600_000,
  async fetch({ http, scope }) {
    const counties = scope.countyFips.map((c) => `'${c.slice(2)}'`).join(',');
    const params = {
      where: `STATE='${scope.stateFips}' AND COUNTY IN (${counties})`,
      outFields: 'GEOID,NAME,STATE,COUNTY,AREALAND',
      returnGeometry: 'true',
    };
    async function* rows(): AsyncIterable<RawRow> {
      for await (const f of arcgisFeatures(http, TRACTS_LAYER, params)) {
        const p = f.properties ?? {};
        const state = String(p['STATE'] ?? '');
        yield {
          geoid: p['GEOID'],
          name: p['NAME'] ?? null,
          stateFips: state,
          countyFips: `${state}${String(p['COUNTY'] ?? '')}`,
          landM2: typeof p['AREALAND'] === 'number' ? Math.round(p['AREALAND']) : null,
          geometry: f.geometry,
        };
      }
    }
    return {
      vintage: 'TIGERweb current',
      sourceUrl: arcgisQueryUrl(TRACTS_LAYER, params, 0, 1000),
      rows: rows(),
    };
  },
};

/** ACS variables asked for: estimates (E) and the margins of error (M) kept with them. */
const AGE65 = [20, 21, 22, 23, 24, 25, 44, 45, 46, 47, 48, 49].map(
  (n) => `B01001_${String(n).padStart(3, '0')}E`,
);
const LANGUAGE = ['002', '003', '004', '006', '007', '009', '010', '012', '013'].map(
  (n) => `C16002_${n}E`,
);
export const ACS_VARIABLES = [
  'NAME',
  'B01003_001E',
  'B01003_001M',
  'B11001_001E',
  'B25003_003E',
  'B25003_003M',
  'B19013_001E',
  'B19013_001M',
  'B17001_001E',
  'B17001_002E',
  'B22010_001E',
  'B22010_002E',
  'B19056_001E',
  'B19056_002E',
  'B01001_001E',
  ...AGE65,
  'C18108_001E',
  'C18108_005E',
  'C18108_009E',
  'C18108_013E',
  ...LANGUAGE,
  'B25044_003E',
  'B25044_010E',
] as const;

/** The Census marks unavailable estimates with large negative numbers. */
function estimate(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function share(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole === 0) return null;
  return Math.min(100, Math.round((part / whole) * 1000) / 10);
}

function sum(values: (number | null)[]): number | null {
  return values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/** One tract's profile from a row of the Data API's table (header row first). */
export function acsProfileRow(header: string[], cells: unknown[]): RawRow {
  const at = (name: string) => estimate(cells[header.indexOf(name)]);
  const geoid = `${String(cells[header.indexOf('state')])}${String(cells[header.indexOf('county')])}${String(cells[header.indexOf('tract')])}`;
  const totalAge = at('B01001_001E');
  const noDisability = sum(['C18108_005E', 'C18108_009E', 'C18108_013E'].map(at));
  const disabilityUniverse = at('C18108_001E');
  const languages: Record<string, number> = {};
  for (const [key, v] of [
    ['english', 'C16002_002E'],
    ['spanish', 'C16002_003E'],
    ['otherIndoEuropean', 'C16002_006E'],
    ['asianPacific', 'C16002_009E'],
    ['other', 'C16002_012E'],
  ] as const) {
    const n = at(v);
    if (n !== null) languages[key] = n;
  }
  const moe: Record<string, number> = {};
  for (const [key, v] of [
    ['population', 'B01003_001M'],
    ['renterHouseholds', 'B25003_003M'],
    ['medianHouseholdIncome', 'B19013_001M'],
  ] as const) {
    const n = at(v);
    if (n !== null) moe[key] = n;
  }
  return {
    geoid,
    population: at('B01003_001E'),
    households: at('B11001_001E'),
    renterHouseholds: at('B25003_003E'),
    medianHouseholdIncome: at('B19013_001E'),
    povertyPct: share(at('B17001_002E'), at('B17001_001E')),
    snapHouseholdsPct: share(at('B22010_002E'), at('B22010_001E')),
    ssiHouseholdsPct: share(at('B19056_002E'), at('B19056_001E')),
    age65Pct: share(sum(AGE65.map(at)), totalAge),
    disabilityPct:
      disabilityUniverse !== null && noDisability !== null
        ? share(disabilityUniverse - noDisability, disabilityUniverse)
        : null,
    limitedEnglishHouseholds: sum(
      ['C16002_004E', 'C16002_007E', 'C16002_010E', 'C16002_013E'].map(at),
    ),
    noVehicleHouseholds: sum(['B25044_003E', 'B25044_010E'].map(at)),
    languages,
    moe,
  };
}

export const acsTractProfile: Connector = {
  id: 'census.acs5.tract_profile',
  dataset: 'tract_profile',
  title: `Tract population profile (Census Bureau, ACS ${ACS_YEAR - 4}–${ACS_YEAR} 5-year)`,
  licence: 'U.S. government work (Census Bureau)',
  hosts: [DATA_API],
  refreshMs: 30 * 24 * 3600_000,
  async fetch({ http, scope, secrets }) {
    const url = (county: string, withKey: boolean) => {
      const u = new URL(`https://${DATA_API}/data/${ACS_YEAR}/acs/acs5`);
      u.searchParams.set('get', ACS_VARIABLES.join(','));
      u.searchParams.set('for', 'tract:*');
      u.searchParams.set('in', `state:${scope.stateFips} county:${county.slice(2)}`);
      if (withKey && secrets.censusApiKey) u.searchParams.set('key', secrets.censusApiKey);
      return u.toString();
    };
    async function* rows(): AsyncIterable<RawRow> {
      for (const county of scope.countyFips) {
        const table = (await http.getJson(url(county, true))) as unknown[][];
        if (!Array.isArray(table) || table.length === 0) continue;
        const header = (table[0] as unknown[]).map(String);
        for (const cells of table.slice(1)) yield acsProfileRow(header, cells);
      }
    }
    return {
      vintage: `ACS ${ACS_YEAR - 4}-${ACS_YEAR} 5-year`,
      sourceUrl: url(scope.countyFips[0] ?? '', false),
      rows: rows(),
    };
  },
};
