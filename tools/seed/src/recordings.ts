/**
 * Recorded reference responses for the WESTWIND exercise county (layer-6
 * task B; ADR-0039, SCL-12). Development and CI never call the federal
 * services: each connector replays a response in its source's real format,
 * filled here with synthetic values derived from the seed's own geography,
 * so the reference data lines up with the seeded parcels, areas and
 * facilities:
 * - five census tracts, one per seed area band, over a fictional county
 *   outline (state 29, county 29999, which no real county uses);
 * - each tract's ACS profile from its area's households, renter and
 *   Spanish-speaking shares (one estimate suppressed, as the Census does);
 * - one NSI structure per seed parcel building, plus the public buildings;
 * - flood hazard zones along an invented creek; CMS facilities; NFIP
 *   policies; EXERCISE weather alerts; earlier EXERCISE declarations
 *   numbered outside FEMA's range.
 * `pnpm --filter @cg/seed recordings` rewrites packages/refdata/recordings;
 * a test fails when the files there differ from what this produces.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACS_VARIABLES, type Recording } from '@cg/refdata';
import { areas, parcels, tenants } from './county.ts';
import { Rng } from './random.ts';

const STATE = '29';
const COUNTY = '999';
const FIPS = `${STATE}${COUNTY}`;
/** The fictional county outline: [west, south, east, north], the seed's own (county.ts). */
export const COUNTY_BBOX = tenants.find((t) => t.key === 'county')!.outline!;
const SOUTH = COUNTY_BBOX[1];
const NORTH = COUNTY_BBOX[3];

type Box = [number, number, number, number];
const ring = ([w, s, e, n]: Box) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Approximate area of a lon/lat box in square metres. */
function boxArea([w, s, e, n]: Box): number {
  const lat = ((s + n) / 2) * (Math.PI / 180);
  return Math.round((e - w) * 111_320 * Math.cos(lat) * (n - s) * 111_320);
}

interface TractSpec {
  tract: string;
  name: string;
  west: number;
  east: number;
  /** The seed areas inside, and households beyond them. */
  areas: string[];
  otherHouseholds: number;
  medianIncome: number | null;
  povertyPct: number;
  snapPct: number;
  ssiPct: number;
  age65Pct: number;
  disabilityPct: number;
  noVehiclePct: number;
}

export const TRACTS: TractSpec[] = [
  {
    tract: '000100',
    name: 'Census Tract 1',
    west: -90.95,
    east: -90.88,
    areas: ['willow-bend'],
    otherHouseholds: 60,
    medianIncome: 34_500,
    povertyPct: 24,
    snapPct: 21,
    ssiPct: 7,
    age65Pct: 18,
    disabilityPct: 17,
    noVehiclePct: 12,
  },
  {
    tract: '000200',
    name: 'Census Tract 2',
    west: -90.88,
    east: -90.858,
    areas: ['cedar-ridge'],
    otherHouseholds: 40,
    medianIncome: 29_800,
    povertyPct: 31,
    snapPct: 27,
    ssiPct: 6,
    age65Pct: 9,
    disabilityPct: 12,
    noVehiclePct: 19,
  },
  {
    tract: '000300',
    name: 'Census Tract 3',
    west: -90.858,
    east: -90.842,
    areas: ['commercial'],
    otherHouseholds: 45,
    // Too few households for a reliable median: the Census suppresses it.
    medianIncome: null,
    povertyPct: 15,
    snapPct: 12,
    ssiPct: 4,
    age65Pct: 14,
    disabilityPct: 13,
    noVehiclePct: 10,
  },
  {
    tract: '000400',
    name: 'Census Tract 4',
    west: -90.842,
    east: -90.822,
    areas: ['prairie-lakes'],
    otherHouseholds: 80,
    medianIncome: 78_900,
    povertyPct: 6,
    snapPct: 4,
    ssiPct: 2,
    age65Pct: 16,
    disabilityPct: 9,
    noVehiclePct: 2,
  },
  {
    tract: '000500',
    name: 'Census Tract 5',
    west: -90.822,
    east: -90.75,
    areas: ['oak-hollow'],
    otherHouseholds: 900,
    medianIncome: 61_300,
    povertyPct: 11,
    snapPct: 9,
    ssiPct: 4,
    age65Pct: 21,
    disabilityPct: 14,
    noVehiclePct: 5,
  },
];

const geoid = (t: TractSpec) => `${FIPS}${t.tract}`;
const tractBox = (t: TractSpec): Box => [t.west, SOUTH, t.east, NORTH];
export function tractAt(lon: number): TractSpec {
  return TRACTS.find((t) => lon >= t.west && lon < t.east) ?? TRACTS[TRACTS.length - 1]!;
}

function tigerweb() {
  return {
    type: 'FeatureCollection',
    features: TRACTS.map((t, i) => ({
      type: 'Feature',
      id: i + 1,
      geometry: { type: 'Polygon', coordinates: [ring(tractBox(t))] },
      properties: {
        OBJECTID: i + 1,
        MTFCC: 'G5020',
        GEOID: geoid(t),
        STATE,
        COUNTY,
        TRACT: t.tract,
        BASENAME: String(Number(t.tract) / 100),
        NAME: t.name,
        AREALAND: boxArea(tractBox(t)),
        AREAWATER: 0,
      },
    })),
  };
}

/** One tract's ACS row, as the Data API returns it (strings; suppressed estimates negative). */
function acsRow(t: TractSpec): string[] {
  const seedAreas = areas.filter((a) => t.areas.includes(a.key));
  const seedHouseholds = seedAreas.reduce((n, a) => n + a.units, 0);
  const households = seedHouseholds + t.otherHouseholds;
  const renters = Math.round(
    seedAreas.reduce((n, a) => n + a.units * a.renterShare, 0) + t.otherHouseholds * 0.3,
  );
  const spanish = Math.round(
    seedAreas.reduce((n, a) => n + a.units * a.spanishShare, 0) + t.otherHouseholds * 0.05,
  );
  const perHousehold = t.areas.includes('cedar-ridge') ? 2.3 : 2.6;
  const population = Math.round(households * perHousehold);
  const part = (whole: number, pct: number) => Math.round((whole * pct) / 100);
  const povertyUniverse = Math.round(population * 0.98);
  const over65 = part(population, t.age65Pct);
  // Twelve age groups 65 and over (men, then women), split roughly evenly.
  const ageCells = Array.from(
    { length: 12 },
    (_, i) => Math.floor(over65 / 12) + (i < over65 % 12 ? 1 : 0),
  );
  const disabilityUniverse = Math.round(population * 0.97);
  const disabled = part(disabilityUniverse, t.disabilityPct);
  const noneUnder18 = Math.round((disabilityUniverse - disabled) * 0.24);
  const none65 = Math.round((disabilityUniverse - disabled) * (t.age65Pct / 100) * 0.7);
  const none1864 = disabilityUniverse - disabled - noneUnder18 - none65;
  const limitedSpanish = Math.round(spanish * 0.4);
  const otherIe = Math.round(households * 0.02);
  const asian = Math.round(households * 0.01);
  const other = Math.round(households * 0.005);
  const english = households - spanish - otherIe - asian - other;
  const noVehicle = part(households, t.noVehiclePct);
  const noVehicleRenters = Math.round(noVehicle * 0.7);
  const values: Record<string, number | string> = {
    NAME: `${t.name}; Westwind County; Missouri`,
    B01003_001E: population,
    B01003_001M: Math.round(population * 0.12) + 20,
    B11001_001E: households,
    B25003_003E: renters,
    B25003_003M: Math.round(renters * 0.18) + 12,
    B19013_001E: t.medianIncome ?? -666666666,
    B19013_001M: t.medianIncome ? Math.round(t.medianIncome * 0.14) : -222222222,
    B17001_001E: povertyUniverse,
    B17001_002E: part(povertyUniverse, t.povertyPct),
    B22010_001E: households,
    B22010_002E: part(households, t.snapPct),
    B19056_001E: households,
    B19056_002E: part(households, t.ssiPct),
    B01001_001E: population,
    C18108_001E: disabilityUniverse,
    C18108_005E: noneUnder18,
    C18108_009E: none1864,
    C18108_013E: none65,
    C16002_002E: english,
    C16002_003E: spanish,
    C16002_004E: limitedSpanish,
    C16002_006E: otherIe,
    C16002_007E: Math.round(otherIe * 0.2),
    C16002_009E: asian,
    C16002_010E: Math.round(asian * 0.3),
    C16002_012E: other,
    C16002_013E: 0,
    B25044_003E: noVehicle - noVehicleRenters,
    B25044_010E: noVehicleRenters,
  };
  [20, 21, 22, 23, 24, 25, 44, 45, 46, 47, 48, 49].forEach((n, i) => {
    values[`B01001_${String(n).padStart(3, '0')}E`] = ageCells[i]!;
  });
  return [...ACS_VARIABLES.map((v) => String(values[v])), STATE, COUNTY, t.tract];
}

function acs() {
  return [[...ACS_VARIABLES, 'state', 'county', 'tract'], ...TRACTS.map(acsRow)];
}

/** One NSI structure per seed parcel building, and the county's public buildings. */
function nsi() {
  const rng = new Rng(29999);
  const features: unknown[] = [];
  let n = 0;
  const add = (
    lon: number,
    lat: number,
    occtype: string,
    damcat: string,
    stories: number,
    found: string,
    value: number,
    year: number,
    sqft: number,
  ) => {
    n++;
    const t = tractAt(lon);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
      properties: {
        fd_id: 990_000_000 + n,
        bid: `EXERCISE-${String(n).padStart(5, '0')}`,
        occtype,
        st_damcat: damcat,
        bldgtype: occtype.startsWith('RES2') ? 'H' : damcat === 'RES' ? 'W' : 'M',
        found_type: found,
        cbfips: `${geoid(t)}${String(1000 + (n % 40)).padStart(4, '0')}`,
        sqft,
        num_story: stories,
        found_ht: found === 'S' ? 0.5 : found === 'B' ? 2 : 3,
        val_struct: value,
        val_cont: Math.round(value * (damcat === 'RES' ? 0.5 : 1)),
        med_yr_blt: year,
        source: 'EXERCISE',
        x: round6(lon),
        y: round6(lat),
      },
    });
  };
  for (const p of parcels(new Rng(2026))) {
    const outer = p.geometry.type === 'Polygon' ? p.geometry.coordinates[0]! : [];
    const lon = (outer[0]![0] + outer[2]![0]) / 2;
    const lat = (outer[0]![1] + outer[2]![1]) / 2;
    switch (p.properties.structure) {
      case 'manufactured':
        add(
          lon,
          lat,
          'RES2',
          'RES',
          1,
          'P',
          38_000 + rng.int(0, 22_000),
          1985 + rng.int(0, 30),
          1100,
        );
        break;
      case 'apartment_building':
        add(lon, lat, 'RES3E', 'RES', 3, 'S', 2_400_000 + rng.int(0, 600_000), 1998, 21_000);
        break;
      case 'commercial':
        add(
          lon,
          lat,
          'COM1',
          'COM',
          1,
          'S',
          420_000 + rng.int(0, 300_000),
          1990 + rng.int(0, 25),
          6_000,
        );
        break;
      default: {
        const twoStory = rng.int(0, 3) === 0;
        add(
          lon,
          lat,
          twoStory ? 'RES1-2SWB' : 'RES1-1SNB',
          'RES',
          twoStory ? 2 : 1,
          twoStory ? 'B' : 'C',
          145_000 + rng.int(0, 120_000),
          1970 + rng.int(0, 50),
          twoStory ? 2_300 : 1_500,
        );
      }
    }
  }
  add(-90.79, 38.812, 'EDU1', 'PUB', 2, 'S', 9_800_000, 1974, 96_000);
  add(-90.873, 38.801, 'REL1', 'PUB', 1, 'S', 1_100_000, 1962, 8_500);
  add(-90.86, 38.797, 'GOV1', 'PUB', 1, 'S', 3_200_000, 2004, 18_000);
  return { type: 'FeatureCollection', features };
}

/** Flood hazard zones along an invented creek through Willow Bend and Cedar Ridge. */
function nfhl() {
  const zone = (
    id: number,
    box: Box,
    FLD_ZONE: string,
    SFHA_TF: 'T' | 'F',
    STATIC_BFE: number,
    ZONE_SUBTY: string | null,
  ) => ({
    type: 'Feature',
    id,
    geometry: { type: 'Polygon', coordinates: [ring(box)] },
    properties: {
      OBJECTID: id,
      DFIRM_ID: `${FIPS}C`,
      FLD_AR_ID: `${FIPS}C_${id}`,
      FLD_ZONE,
      ZONE_SUBTY,
      SFHA_TF,
      STATIC_BFE,
      V_DATUM: STATIC_BFE > 0 ? 'NAVD88' : null,
      SOURCE_CIT: 'EXERCISE',
    },
  });
  return {
    type: 'FeatureCollection',
    features: [
      zone(1, [-90.95, 38.786, -90.858, 38.792], 'AE', 'T', 452.0, null),
      zone(2, [-90.822, 38.808, -90.8, 38.815], 'A', 'T', -9999, null),
      zone(
        3,
        [-90.95, 38.792, -90.858, 38.795],
        'X',
        'F',
        -9999,
        '0.2 PCT ANNUAL CHANCE FLOOD HAZARD',
      ),
      zone(4, [-90.95, 38.795, -90.75, 38.84], 'X', 'F', -9999, 'AREA OF MINIMAL FLOOD HAZARD'),
    ],
  };
}

function cms(kind: 'hospital' | 'nursing_home') {
  const results =
    kind === 'hospital'
      ? [
          {
            facility_id: 'EX0001',
            facility_name: 'WESTWIND MEMORIAL HOSPITAL (EXERCISE)',
            address: '1200 HOSPITAL DRIVE',
            citytown: 'HARMON CITY',
            state: 'MO',
            zip_code: '63005',
            countyparish: 'WESTWIND',
            telephone_number: '(555) 010-0100',
            hospital_type: 'Acute Care Hospitals',
            hospital_ownership: 'Government - Hospital District or Authority',
            emergency_services: 'Yes',
          },
        ]
      : [
          {
            cms_certification_number_ccn: 'EX0101',
            provider_name: 'PRAIRIE LAKES CARE CENTER (EXERCISE)',
            provider_address: '400 PRAIRIE LANE',
            citytown: 'WESTWIND',
            state: 'MO',
            zip_code: '63003',
            telephone_number: '(555) 010-0140',
            countyparish: 'WESTWIND',
            number_of_certified_beds: '96',
            latitude: '38.8031',
            longitude: '-90.8322',
          },
          {
            cms_certification_number_ccn: 'EX0102',
            provider_name: 'OAK HOLLOW SENIOR LIVING (EXERCISE)',
            provider_address: '75 HICKORY COURT',
            citytown: 'HARMON CITY',
            state: 'MO',
            zip_code: '63004',
            telephone_number: '(555) 010-0150',
            countyparish: 'WESTWIND',
            number_of_certified_beds: '60',
            latitude: '',
            longitude: '',
          },
        ];
  return { results, count: results.length, query: { limit: 500, offset: 0 } };
}

/** NFIP policies in force: a few per tract, more in the flood zone. */
function nfip() {
  const rng = new Rng(4242);
  const perTract: Record<string, number> = {
    '000100': 38,
    '000200': 9,
    '000300': 4,
    '000400': 12,
    '000500': 6,
  };
  const policies: Record<string, unknown>[] = [];
  for (const [tract, n] of Object.entries(perTract))
    for (let i = 0; i < n; i++) {
      const home = !(tract === '000300' && i < 3);
      policies.push({
        countyCode: FIPS,
        censusTract: `${FIPS}${tract}`,
        policyCount: 1,
        occupancyType: home ? (tract === '000100' ? 14 : 11) : 18,
        totalBuildingInsuranceCoverage: home ? 60_000 + rng.int(0, 140_000) : 250_000,
        totalContentsInsuranceCoverage: home ? rng.int(0, 2) * 25_000 : 100_000,
        policyEffectiveDate: '2026-03-01T00:00:00.000Z',
        policyTerminationDate: '2027-03-01T00:00:00.000Z',
        id: `00000000-0000-4000-9000-${String(policies.length + 1).padStart(12, '0')}`,
      });
    }
  return {
    metadata: {
      skip: 0,
      top: 10000,
      entityname: 'FimaNfipPolicies',
      version: 'v2',
      count: policies.length,
    },
    FimaNfipPolicies: policies,
  };
}

function nws() {
  const alert = (
    id: string,
    event: string,
    severity: string,
    urgency: string,
    headline: string,
    geometry: unknown,
    effective: string,
    expires: string,
  ) => ({
    id: `https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.exercise.${id}`,
    type: 'Feature',
    geometry,
    properties: {
      '@id': `https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.exercise.${id}`,
      '@type': 'wx:Alert',
      id: `urn:oid:2.49.0.1.840.0.exercise.${id}`,
      areaDesc: 'Westwind, MO',
      geocode: { SAME: [`0${FIPS}`], UGC: [`MOC${COUNTY}`] },
      affectedZones: [`https://api.weather.gov/zones/county/MOC${COUNTY}`],
      references: [],
      sent: effective,
      effective,
      onset: effective,
      expires,
      ends: expires,
      status: 'Exercise',
      messageType: 'Alert',
      category: 'Met',
      severity,
      certainty: 'Observed',
      urgency,
      event,
      sender: 'w-nws.webmaster@noaa.gov',
      senderName: 'NWS (EXERCISE)',
      headline,
      description: 'EXERCISE EXERCISE EXERCISE. This is not a real alert.',
      instruction: null,
      response: 'Shelter',
    },
  });
  return {
    '@context': ['https://geojson.org/geojson-ld/geojson-context.jsonld'],
    type: 'FeatureCollection',
    features: [
      alert(
        'westwind.1',
        'Tornado Warning',
        'Extreme',
        'Immediate',
        'EXERCISE Tornado Warning issued for Westwind County',
        { type: 'Polygon', coordinates: [ring([-90.93, 38.78, -90.85, 38.81])] },
        '2026-10-14T16:05:00-05:00',
        '2026-10-14T16:45:00-05:00',
      ),
      alert(
        'westwind.2',
        'Flood Watch',
        'Moderate',
        'Expected',
        'EXERCISE Flood Watch for Westwind County',
        null,
        '2026-10-14T12:00:00-05:00',
        '2026-10-15T07:00:00-05:00',
      ),
    ],
    title: `Current watches, warnings, and advisories for Westwind (MOC${COUNTY}) MO (EXERCISE)`,
    updated: '2026-10-14T16:05:00-05:00',
  };
}

function declarations() {
  const d = (
    n: number,
    type: string,
    date: string,
    incident: string,
    title: string,
    programs: { ih: boolean; ia: boolean; pa: boolean; hm: boolean },
    begin: string,
    end: string,
    closeout: string | null,
    statewide: boolean,
  ) => ({
    femaDeclarationString: `${type}-${n}-MO`,
    disasterNumber: n,
    state: 'MO',
    declarationType: type,
    declarationDate: `${date}T00:00:00.000Z`,
    fyDeclared: Number(date.slice(0, 4)),
    incidentType: incident,
    declarationTitle: title,
    ihProgramDeclared: programs.ih,
    iaProgramDeclared: programs.ia,
    paProgramDeclared: programs.pa,
    hmProgramDeclared: programs.hm,
    incidentBeginDate: `${begin}T00:00:00.000Z`,
    incidentEndDate: `${end}T00:00:00.000Z`,
    disasterCloseoutDate: closeout ? `${closeout}T00:00:00.000Z` : null,
    tribalRequest: false,
    fipsStateCode: STATE,
    fipsCountyCode: statewide ? '000' : COUNTY,
    placeCode: statewide ? '0' : '99999',
    designatedArea: statewide ? 'Statewide' : 'Westwind (County)',
    declarationRequestNumber: `99${String(n).slice(-3)}`,
    incidentId: String(n),
    region: 7,
    lastRefresh: '2026-10-14T00:00:00.000Z',
    id: `00000000-0000-4000-8000-00000000${n}`,
  });
  const rows = [
    d(
      9903,
      'DR',
      '2024-06-21',
      'Severe Storm',
      'EXERCISE SEVERE STORMS, STRAIGHT-LINE WINDS, TORNADOES, AND FLOODING',
      { ih: true, ia: false, pa: true, hm: true },
      '2024-05-19',
      '2024-05-27',
      null,
      false,
    ),
    d(
      9902,
      'EM',
      '2022-02-03',
      'Severe Ice Storm',
      'EXERCISE SEVERE WINTER STORM',
      { ih: false, ia: false, pa: true, hm: false },
      '2022-02-01',
      '2022-02-05',
      '2024-01-15',
      true,
    ),
    d(
      9901,
      'DR',
      '2019-07-09',
      'Flood',
      'EXERCISE SEVERE STORMS, TORNADOES, AND FLOODING',
      { ih: true, ia: false, pa: true, hm: true },
      '2019-04-29',
      '2019-07-05',
      '2023-09-30',
      false,
    ),
  ];
  return {
    metadata: {
      skip: 0,
      top: 1000,
      entityname: 'DisasterDeclarationsSummaries',
      version: 'v2',
      count: rows.length,
    },
    DisasterDeclarationsSummaries: rows,
  };
}

/** Everything under packages/refdata/recordings, as file name → content. */
export function buildRecordings(): Record<string, string> {
  const files: Record<string, string> = {};
  const index: Recording[] = [];
  const put = (file: string, body: unknown, rec: Omit<Recording, 'file'>) => {
    files[file] = `${JSON.stringify(body)}\n`;
    index.push({ ...rec, file });
  };
  put('tigerweb-tracts-29999.json', tigerweb(), {
    host: 'tigerweb.geo.census.gov',
    path: '/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query',
    query: { where: `STATE='${STATE}' AND COUNTY IN ('${COUNTY}')`, resultOffset: '0' },
  });
  put('acs5-tract-profile-29999.json', acs(), {
    host: 'api.census.gov',
    path: '/data/2024/acs/acs5',
    query: { for: 'tract:*', in: `state:${STATE} county:${COUNTY}` },
  });
  put('nsi-structures-29999.json', nsi(), {
    host: 'nsi.sec.usace.army.mil',
    path: '/nsiapi/structures',
    query: { fips: FIPS },
  });
  put('nfhl-flood-zones-29999.json', nfhl(), {
    host: 'hazards.fema.gov',
    path: '/arcgis/rest/services/public/NFHL/MapServer/28/query',
    query: { resultOffset: '0' },
    contains: { geometry: '-90.95' },
  });
  put('cms-hospitals-westwind.json', cms('hospital'), {
    host: 'data.cms.gov',
    path: '/provider-data/api/1/datastore/query/xubh-q36u/0',
    query: { 'conditions[0][value]': 'MO', 'conditions[1][value]': 'WESTWIND', offset: '0' },
  });
  put('cms-nursing-homes-westwind.json', cms('nursing_home'), {
    host: 'data.cms.gov',
    path: '/provider-data/api/1/datastore/query/4pq5-n9py/0',
    query: { 'conditions[0][value]': 'MO', 'conditions[1][value]': 'WESTWIND', offset: '0' },
  });
  put('openfema-declarations-29999.json', declarations(), {
    host: 'www.fema.gov',
    path: '/api/open/v2/DisasterDeclarationsSummaries',
    query: {
      $filter: `fipsStateCode eq '${STATE}' and (fipsCountyCode eq '000' or fipsCountyCode eq '${COUNTY}')`,
      $skip: '0',
    },
  });
  put('openfema-nfip-policies-29999.json', nfip(), {
    host: 'www.fema.gov',
    path: '/api/open/v2/FimaNfipPolicies',
    query: { $skip: '0' },
    contains: { $filter: `countyCode eq '${FIPS}'` },
  });
  put('nws-alerts-29999.json', nws(), {
    host: 'api.weather.gov',
    path: '/alerts/active',
    query: { zone: `MOC${COUNTY}` },
  });
  files['index.json'] = `${JSON.stringify(index, null, 2)}\n`;
  return files;
}

export const RECORDINGS_DIR = fileURLToPath(
  new URL('../../../packages/refdata/recordings', import.meta.url),
);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  for (const [file, body] of Object.entries(buildRecordings()))
    writeFileSync(join(RECORDINGS_DIR, file), body);
  console.log(`wrote ${Object.keys(buildRecordings()).length} files to ${RECORDINGS_DIR}`);
}
