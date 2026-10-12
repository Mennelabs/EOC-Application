/**
 * Synthetic county for development and tests (SCL-12, CLAUDE.md rule 1),
 * modelled on Exercise WESTWIND (docs/02). Everything here is invented:
 * - the county, city, partner organisations, streets, parcels and people;
 * - phone numbers use 555-0100..0199, reserved for fiction in the NANP;
 * - email addresses use example.org, reserved by RFC 2606.
 * Geometry sits over real terrain west of St. Louis so the self-hosted OSM
 * base map has something under it, but parcels and addresses are generated.
 */
import { Rng } from './random.ts';

export const SYNTHETIC = { synthetic: true, source: 'tools/seed', exercise: 'WESTWIND' } as const;

type Position = [number, number];
type Ring = Position[];

export interface Feature<P> {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: Ring[] } | { type: 'Point'; coordinates: Position };
  properties: P & typeof SYNTHETIC;
}

export interface Tenant {
  key: string;
  kind: 'state' | 'region' | 'county' | 'city' | 'partner_org';
  name: string;
  parent: string | null;
  timezone: string;
  locales: string[];
}

export interface Area {
  key: string;
  name: string;
  kind:
    'manufactured_home_community' | 'apartment_complex' | 'subdivision' | 'commercial' | 'rural';
  units: number;
  renterShare: number;
  spanishShare: number;
  origin: Position;
}

export const tenants: Tenant[] = [
  {
    key: 'state',
    kind: 'state',
    name: 'Missouri (exercise tenant)',
    parent: null,
    timezone: 'America/Chicago',
    locales: ['en', 'es'],
  },
  {
    key: 'region',
    kind: 'region',
    name: 'East Central Region (exercise)',
    parent: 'state',
    timezone: 'America/Chicago',
    locales: ['en', 'es'],
  },
  {
    key: 'county',
    kind: 'county',
    name: 'Westwind County',
    parent: 'region',
    timezone: 'America/Chicago',
    locales: ['en', 'es'],
  },
  {
    key: 'city',
    kind: 'city',
    name: 'Harmon City',
    parent: 'county',
    timezone: 'America/Chicago',
    locales: ['en', 'es'],
  },
  {
    key: 'coad',
    kind: 'partner_org',
    name: 'Westwind COAD',
    parent: 'county',
    timezone: 'America/Chicago',
    locales: ['en'],
  },
  {
    key: 'canteen',
    kind: 'partner_org',
    name: 'Hope Canteen Services',
    parent: 'county',
    timezone: 'America/Chicago',
    locales: ['en'],
  },
  {
    key: 'shelter-ngo',
    kind: 'partner_org',
    name: 'Prairie Shelter Alliance',
    parent: 'county',
    timezone: 'America/Chicago',
    locales: ['en', 'es'],
  },
  {
    key: 'cleanup',
    kind: 'partner_org',
    name: 'Gateway Cleanup Volunteers',
    parent: 'county',
    timezone: 'America/Chicago',
    locales: ['en'],
  },
  {
    key: 'legal',
    kind: 'partner_org',
    name: 'Riverside Legal Aid',
    parent: 'county',
    timezone: 'America/Chicago',
    locales: ['en', 'es'],
  },
];

/** Areas from the WESTWIND narrative (docs/02, "touchdown" and "equity alert"). */
export const areas: Area[] = [
  {
    key: 'willow-bend',
    name: 'Willow Bend',
    kind: 'manufactured_home_community',
    units: 190,
    renterShare: 0.55,
    spanishShare: 0.2,
    origin: [-90.905, 38.79],
  },
  {
    key: 'cedar-ridge',
    name: 'Cedar Ridge',
    kind: 'apartment_complex',
    units: 312,
    renterShare: 0.97,
    spanishShare: 0.6,
    origin: [-90.87, 38.795],
  },
  {
    key: 'prairie-lakes',
    name: 'Prairie Lakes',
    kind: 'subdivision',
    units: 240,
    renterShare: 0.12,
    spanishShare: 0.05,
    origin: [-90.835, 38.8],
  },
  {
    key: 'oak-hollow',
    name: 'Oak Hollow',
    kind: 'rural',
    units: 74,
    renterShare: 0.25,
    spanishShare: 0.08,
    origin: [-90.815, 38.805],
  },
  {
    key: 'commercial',
    name: 'Route 94 commercial strip',
    kind: 'commercial',
    units: 28,
    renterShare: 1,
    spanishShare: 0.1,
    origin: [-90.85, 38.79],
  },
];

const streetNames = [
  'Willow',
  'Cedar',
  'Prairie',
  'Oak',
  'Maple',
  'Juniper',
  'Sycamore',
  'Hickory',
  'Aspen',
  'Birch',
  'Redbud',
  'Magnolia',
];
const streetTypes = ['Lane', 'Drive', 'Court', 'Way', 'Circle'];
const given = [
  'Alex',
  'Jordan',
  'Sam',
  'Taylor',
  'Riley',
  'Casey',
  'Morgan',
  'Avery',
  'Quinn',
  'Rowan',
  'Elena',
  'Mateo',
  'Lucía',
  'Diego',
  'Sofía',
  'Andrés',
  'Mei',
  'Omar',
  'Priya',
  'Tomasz',
];
const family = [
  'Rivera',
  'Okafor',
  'Lindqvist',
  'Haddad',
  'Nguyen',
  'Brennan',
  'Castillo',
  'Moreau',
  'Kowalski',
  'Adeyemi',
  'Fairbank',
  'Delgado',
  'Whitlock',
  'Osei',
  'Marchetti',
];

/** NANP fictional range 555-0100..0199 (CLAUDE.md rule 1: never a real number). */
export function fictionalPhone(rng: Rng): string {
  return `+1314555${String(rng.int(100, 199)).padStart(4, '0')}`;
}

export function fictionalName(rng: Rng): string {
  return `${rng.pick(given)} ${rng.pick(family)}`;
}

const DEG_PER_M_LAT = 1 / 111_320;
const degPerMLon = (lat: number) => 1 / (111_320 * Math.cos((lat * Math.PI) / 180));

export interface ParcelProps {
  parcelId: string;
  area: string;
  address: string;
  unitCount: number;
  structure: 'manufactured' | 'apartment_building' | 'single_family' | 'commercial';
}

/** Parcels on a regular grid per area: unreal on purpose, easy to recognise as synthetic. */
export function parcels(rng: Rng): Feature<ParcelProps>[] {
  const out: Feature<ParcelProps>[] = [];
  for (const area of areas) {
    const perBuilding = area.kind === 'apartment_complex' ? 24 : 1;
    const count = Math.ceil(area.units / perBuilding);
    const cols = Math.ceil(Math.sqrt(count));
    const size = area.kind === 'apartment_complex' ? 60 : area.kind === 'rural' ? 120 : 30;
    const street = `${rng.pick(streetNames)} ${rng.pick(streetTypes)}`;
    for (let i = 0; i < count; i++) {
      const [lon0, lat0] = area.origin;
      const lon = lon0 + (i % cols) * size * 1.2 * degPerMLon(lat0);
      const lat = lat0 + Math.floor(i / cols) * size * 1.2 * DEG_PER_M_LAT;
      const dLon = size * degPerMLon(lat0);
      const dLat = size * DEG_PER_M_LAT;
      const ring: Ring = [
        [lon, lat],
        [lon + dLon, lat],
        [lon + dLon, lat + dLat],
        [lon, lat + dLat],
        [lon, lat],
      ];
      const structure =
        area.kind === 'manufactured_home_community'
          ? 'manufactured'
          : area.kind === 'apartment_complex'
            ? 'apartment_building'
            : area.kind === 'commercial'
              ? 'commercial'
              : 'single_family';
      out.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring.map(([x, y]) => [round(x), round(y)])] },
        properties: {
          parcelId: `SYN-${area.key.toUpperCase().slice(0, 3)}-${String(i + 1).padStart(4, '0')}`,
          area: area.key,
          address: `${100 + i * 2} ${street}, Harmon City`,
          unitCount: Math.min(perBuilding, area.units - i * perBuilding),
          structure,
          ...SYNTHETIC,
        },
      });
    }
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Facility registry entries used by the shelter recommendation in docs/02 (REC-01..04). */
export const facilities = [
  {
    key: 'hs-gym',
    name: 'Harmon High School gym',
    kind: 'school',
    sqft: 14000,
    ada: true,
    generator: true,
    kitchen: true,
    showers: true,
    pets: false,
    inOutageArea: false,
    location: [-90.79, 38.812],
  },
  {
    key: 'church-hall',
    name: 'Iglesia Nueva Esperanza fellowship hall',
    kind: 'place_of_worship',
    sqft: 2800,
    ada: true,
    generator: false,
    kitchen: true,
    showers: false,
    pets: false,
    inOutageArea: false,
    location: [-90.873, 38.801],
  },
  {
    key: 'community-center',
    name: 'Westwind Community Center',
    kind: 'community_center',
    sqft: 9000,
    ada: true,
    generator: false,
    kitchen: true,
    showers: true,
    pets: true,
    inOutageArea: true,
    location: [-90.86, 38.797],
  },
  {
    key: 'fair-lot',
    name: 'County fairgrounds lot',
    kind: 'parking_lot',
    sqft: 220000,
    ada: true,
    generator: false,
    kitchen: false,
    showers: false,
    pets: true,
    inOutageArea: false,
    location: [-90.8, 38.78],
  },
].map((f) => ({ ...f, ...SYNTHETIC }));

/** Console cast (docs/02) and a few field roles, as synthetic personnel. */
export function personnel(rng: Rng) {
  const roles = [
    'county_em_director',
    'planning_gis_lead',
    'damage_assessment_coordinator',
    'mass_care_coordinator',
    'afn_coordinator',
    'coad_chair',
    'ngo_incident_commander',
    'public_information_officer',
    'state_liaison',
    'damage_assessor',
    'damage_assessor',
    'canvasser',
    'canvasser',
    'cleanup_crew_lead',
    'shelter_worker',
  ];
  return roles.map((role, i) => ({
    key: `person-${i + 1}`,
    name: fictionalName(rng),
    role,
    phone: fictionalPhone(rng),
    email: `person${i + 1}@example.org`,
    ...SYNTHETIC,
  }));
}

export type Channel = 'web' | 'sms' | 'phone' | 'assisted';

/** Resident reports with the WESTWIND channel mix (61/24/9/6) and need mix (docs/02). */
export function reports(rng: Rng, parcelList: Feature<ParcelProps>[], count: number) {
  const homes = parcelList.filter((p) => p.properties.structure !== 'commercial');
  return Array.from({ length: count }, (_, i) => {
    const parcel = rng.pick(homes);
    const area = areas.find((a) => a.key === parcel.properties.area);
    if (!area) throw new Error('parcel without area');
    const language = rng.chance(area.spanishShare) ? 'es' : 'en';
    return {
      key: `report-${i + 1}`,
      parcelId: parcel.properties.parcelId,
      channel: rng.weighted<Channel>([
        ['web', 61],
        ['sms', 24],
        ['phone', 9],
        ['assisted', 6],
      ]),
      language,
      tenure: rng.chance(area.renterShare) ? 'renter' : 'owner',
      isOwnHome: rng.chance(0.93),
      danger: rng.chance(0.02),
      nowhereToStay: rng.chance(0.08),
      needs: {
        foodWater: rng.chance(0.54),
        tarpCleanup: rng.chance(0.34),
        pets: rng.chance(0.03),
        emotionalCare: rng.chance(0.024),
        poweredMedicalEquipment: rng.chance(0.015),
      },
      contactPhone: rng.chance(0.8) ? fictionalPhone(rng) : null,
      ...SYNTHETIC,
    };
  });
}

export function buildCounty(seed: number, reportCount: number) {
  const rng = new Rng(seed);
  const parcelList = parcels(rng);
  return {
    meta: { seed, generatedBy: 'tools/seed', ...SYNTHETIC },
    tenants: tenants.map((t) => ({ ...t, ...SYNTHETIC })),
    areas: areas.map((a) => ({ ...a, ...SYNTHETIC })),
    parcels: { type: 'FeatureCollection' as const, features: parcelList },
    facilities,
    personnel: personnel(rng),
    reports: reports(rng, parcelList, reportCount),
  };
}
