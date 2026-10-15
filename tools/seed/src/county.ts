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
  /**
   * Jurisdiction FIPS code: reference data is pulled for it (ADR-0039). The
   * exercise county uses 29999, which no real county has (SCL-12).
   */
  fips?: string;
  /** Jurisdiction outline [west, south, east, north] in WGS84 (fictional; DCL:DEC-05). */
  outline?: [number, number, number, number];
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
    fips: '29',
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
    fips: '29999',
    outline: [-90.95, 38.76, -90.75, 38.84],
  },
  {
    key: 'city',
    kind: 'city',
    name: 'Harmon City',
    parent: 'county',
    timezone: 'America/Chicago',
    locales: ['en', 'es'],
    outline: [-90.8, 38.8, -90.775, 38.82],
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

/**
 * Facility registry entries used by the shelter recommendation in docs/02
 * (REC-01..04). Some attributes are deliberately unknown (null): the registry
 * and the recommendations say so rather than guess (REC-10).
 */
export const facilities = [
  {
    key: 'hs-gym',
    name: 'Harmon High School gym',
    kind: 'school',
    address: { line1: '200 School Rd', city: 'Harmon City', postal: '63005' },
    sqft: 14000,
    ada: true,
    powerBackup: 'generator',
    kitchen: true,
    showers: 8,
    petPolicy: 'service_animals',
    parkingSpaces: 120,
    truckAccess: true,
    floodplain: 'out',
    mouStatus: 'signed',
    communities: ['Harmon City families', 'High school sports parents'],
    // A live condition, not a registry attribute: used by the recommendation scenario.
    inOutageArea: false,
    location: [-90.79, 38.812],
  },
  {
    key: 'church-hall',
    name: 'Iglesia Nueva Esperanza fellowship hall',
    kind: 'place_of_worship',
    address: { line1: '14 Mission St', city: 'Westwind', postal: '63003' },
    sqft: 2800,
    ada: true,
    powerBackup: 'none',
    kitchen: true,
    showers: 0,
    petPolicy: 'service_animals',
    parkingSpaces: 25,
    truckAccess: false,
    floodplain: null,
    mouStatus: 'pending',
    communities: ['Spanish-speaking households in Westwind'],
    inOutageArea: false,
    location: [-90.873, 38.801],
  },
  {
    key: 'community-center',
    name: 'Westwind Community Center',
    kind: 'community_center',
    address: { line1: '500 Main St', city: 'Westwind', postal: '63003' },
    sqft: 9000,
    ada: true,
    powerBackup: 'none',
    kitchen: true,
    showers: 4,
    petPolicy: 'pets_inside',
    parkingSpaces: 60,
    truckAccess: false,
    floodplain: 'out',
    mouStatus: 'signed',
    communities: ['Westwind seniors', 'Youth programs'],
    inOutageArea: true,
    location: [-90.86, 38.797],
  },
  {
    key: 'fair-lot',
    name: 'County fairgrounds lot',
    kind: 'parking_lot',
    address: { line1: '1 Fairgrounds Rd', city: 'Harmon City', postal: '63005' },
    sqft: 220000,
    ada: true,
    powerBackup: 'none',
    kitchen: false,
    showers: 0,
    petPolicy: 'pets_outside_area',
    parkingSpaces: 800,
    truckAccess: true,
    floodplain: 'out',
    mouStatus: 'none',
    communities: [],
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

/** Public sites for the exercise (layer 3; CON-09, PUB-02–05). One is confidential and never published. */
export interface SiteSpec {
  slug: string;
  kind:
    | 'shelter'
    | 'feeding'
    | 'pod'
    | 'marc'
    | 'cooling'
    | 'warming'
    | 'reporting'
    | 'charging'
    | 'other';
  name: string;
  status: 'planned' | 'open' | 'limited' | 'full' | 'closed';
  address: { line1: string; city: string; postal: string };
  location: [number, number];
  capacity?: number;
  occupancy?: number;
  hours: Record<string, string | boolean>;
  services: string[];
  pets: 'yes' | 'no' | 'service_animals' | 'unknown';
  accessibility: Record<string, boolean>;
  medicalPower: boolean;
  languages: string[];
  transit?: string;
  directions?: string;
  confidential?: boolean;
  publish: boolean;
}

const siteList: SiteSpec[] = [
  {
    slug: 'harmon-high-gym',
    kind: 'shelter',
    name: 'Harmon High School gym',
    status: 'open',
    address: { line1: '400 Schoolhouse Rd', city: 'Harmon City', postal: '63005' },
    location: [-90.79, 38.812],
    capacity: 350,
    occupancy: 112,
    hours: { always: true },
    services: ['cots', 'meals', 'showers', 'charging', 'pet_area_outside'],
    pets: 'service_animals',
    accessibility: { ada: true, wheelchair: true, quiet_room: true, asl_on_request: true },
    medicalPower: true,
    languages: ['en', 'es'],
    transit: 'Route 12 bus stops at the main entrance',
    directions: 'Enter from Schoolhouse Rd; the gym is the first building on the left.',
    publish: true,
  },
  {
    slug: 'nueva-esperanza-hall',
    kind: 'feeding',
    name: 'Iglesia Nueva Esperanza fellowship hall',
    status: 'open',
    address: { line1: '18 Cedar Ridge Pkwy', city: 'Westwind', postal: '63002' },
    location: [-90.873, 38.801],
    hours: { daily: '11:00–13:30' },
    services: ['meals', 'water', 'reporting_table', 'spanish_speaking_volunteers'],
    pets: 'yes',
    accessibility: { ada: true, wheelchair: true },
    medicalPower: false,
    languages: ['es', 'en'],
    transit: 'Route 4 bus, Cedar Ridge stop',
    publish: true,
  },
  {
    slug: 'westwind-community-center',
    kind: 'cooling',
    name: 'Westwind Community Center',
    status: 'closed',
    address: { line1: '1 Civic Plaza', city: 'Westwind', postal: '63003' },
    location: [-90.86, 38.797],
    hours: {},
    services: [],
    pets: 'unknown',
    accessibility: { ada: true },
    medicalPower: false,
    languages: ['en'],
    directions: 'Closed while the power is out.',
    publish: true,
  },
  {
    slug: 'fairgrounds-pod',
    kind: 'pod',
    name: 'County fairgrounds distribution point',
    status: 'planned',
    address: { line1: '2200 Fairgrounds Rd', city: 'Westwind', postal: '63004' },
    location: [-90.8, 38.78],
    hours: { daily: '09:00–18:00' },
    services: ['water', 'ice', 'meals', 'drive_through'],
    pets: 'unknown',
    accessibility: { ada: true, walk_up: true },
    medicalPower: false,
    languages: ['en', 'es'],
    publish: false,
  },
  {
    slug: 'safe-harbor',
    kind: 'shelter',
    name: 'Safe Harbor (confidential, referral only)',
    status: 'open',
    address: { line1: 'Withheld', city: 'Westwind', postal: '63003' },
    location: [-90.85, 38.79],
    capacity: 24,
    hours: { always: true },
    services: ['cots', 'meals', 'advocacy'],
    pets: 'no',
    accessibility: { ada: true },
    medicalPower: false,
    languages: ['en', 'es'],
    confidential: true,
    publish: false,
  },
];
export const sites = siteList.map((f) => ({ ...f, ...SYNTHETIC }));

/** Synthetic ZIP centroids: "nearest" works without the geocoder (SCL-06, PUB-08). */
export const zipCentroids = [
  { postal: '63001', name: 'Willow Bend', location: [-90.905, 38.79] as [number, number] },
  { postal: '63002', name: 'Cedar Ridge', location: [-90.87, 38.795] as [number, number] },
  { postal: '63003', name: 'Westwind', location: [-90.835, 38.8] as [number, number] },
  { postal: '63004', name: 'Oak Hollow', location: [-90.815, 38.805] as [number, number] },
  { postal: '63005', name: 'Harmon City', location: [-90.79, 38.812] as [number, number] },
];

/** Published resources beyond sites (F16, PUB-18); one is expired on purpose (AC-16B). */
export interface ResourceSpec {
  slug: string;
  type: 'hotline' | 'program' | 'deadline' | 'guidance' | 'link' | 'document';
  category: string;
  ordering: number;
  status: 'published' | 'expired' | 'draft';
  referenceUrl?: string;
  expiresInDays?: number;
  text: Record<string, { title: string; summary: string; bodyHtml: string }>;
}

export const resources: ResourceSpec[] = [
  {
    slug: 'county-help-line',
    type: 'hotline',
    category: 'help',
    ordering: 10,
    status: 'published',
    text: {
      en: {
        title: 'County disaster help line',
        summary:
          'Call (314) 555-0142, 7 am to 9 pm, for questions about shelter, food, cleanup or your report.',
        bodyHtml:
          '<p>Call <a href="tel:+13145550142">(314) 555-0142</a> from 7 am to 9 pm. Interpreters are available. If anyone is in danger, call 911.</p>',
      },
      es: {
        title: 'Línea de ayuda del condado',
        summary:
          'Llame al (314) 555-0142, de 7 am a 9 pm, para preguntas sobre refugio, comida, limpieza o su reporte.',
        bodyHtml:
          '<p>Llame al <a href="tel:+13145550142">(314) 555-0142</a> de 7 am a 9 pm. Hay intérpretes. Si alguien está en peligro, llame al 911.</p>',
      },
    },
  },
  {
    slug: 'fema-registration',
    type: 'deadline',
    category: 'money',
    ordering: 20,
    status: 'published',
    referenceUrl: 'https://www.disasterassistance.gov/',
    expiresInDays: 60,
    text: {
      en: {
        title: 'Register with FEMA',
        summary:
          'If a federal disaster is declared, register online or by phone. Registering does not decide what you get.',
        bodyHtml:
          '<p>If a federal disaster is declared for this event, you can register at <a href="https://www.disasterassistance.gov/">DisasterAssistance.gov</a> or by calling 1-800-621-3362. Have your address and a way to be reached. Registering does not decide what help you get; FEMA does.</p>',
      },
      es: {
        title: 'Regístrese con FEMA',
        summary:
          'Si se declara un desastre federal, regístrese en línea o por teléfono. Registrarse no decide qué recibirá.',
        bodyHtml:
          '<p>Si se declara un desastre federal para este evento, puede registrarse en <a href="https://www.disasterassistance.gov/">DisasterAssistance.gov</a> o llamando al 1-800-621-3362. Tenga a mano su dirección y una forma de contacto. Registrarse no decide qué ayuda recibirá; eso lo decide FEMA.</p>',
      },
    },
  },
  {
    slug: 'debris-pickup',
    type: 'guidance',
    category: 'cleanup',
    ordering: 30,
    status: 'published',
    text: {
      en: {
        title: 'Putting debris at the curb',
        summary:
          'Sort debris into piles: plants, building material, appliances, electronics, household chemicals.',
        bodyHtml:
          '<h2>Five piles</h2><ul><li>Plants and branches</li><li>Building material</li><li>Appliances</li><li>Electronics</li><li>Household chemicals, kept apart</li></ul><p>Keep piles off the road, away from mailboxes, hydrants and power lines.</p>',
      },
      es: {
        title: 'Cómo poner los escombros en la acera',
        summary:
          'Separe los escombros en montones: plantas, material de construcción, electrodomésticos, electrónicos, químicos del hogar.',
        bodyHtml:
          '<h2>Cinco montones</h2><ul><li>Plantas y ramas</li><li>Material de construcción</li><li>Electrodomésticos</li><li>Electrónicos</li><li>Químicos del hogar, aparte</li></ul><p>Mantenga los montones fuera de la calle y lejos de buzones, hidrantes y cables eléctricos.</p>',
      },
    },
  },
  {
    slug: 'legal-help',
    type: 'program',
    category: 'help',
    ordering: 40,
    status: 'published',
    text: {
      en: {
        title: 'Free legal help after the storm',
        summary:
          'Volunteer attorneys answer questions about leases, insurance and repairs at no cost.',
        bodyHtml:
          '<p>Volunteer attorneys from Gateway Legal Aid answer questions about leases, insurance claims and repair contracts at no cost. Ask at any help site or call the county help line.</p>',
      },
      es: {
        title: 'Ayuda legal gratuita después de la tormenta',
        summary:
          'Abogados voluntarios responden preguntas sobre contratos de alquiler, seguros y reparaciones sin costo.',
        bodyHtml:
          '<p>Abogados voluntarios de Gateway Legal Aid responden preguntas sobre contratos de alquiler, reclamos de seguro y contratos de reparación sin costo. Pregunte en cualquier sitio de ayuda o llame a la línea del condado.</p>',
      },
    },
  },
  {
    slug: 'boil-water-notice',
    type: 'guidance',
    category: 'water',
    ordering: 5,
    status: 'expired',
    expiresInDays: -2,
    text: {
      en: {
        title: 'Boil water notice (ended)',
        summary: 'The boil water notice for Cedar Ridge ended.',
        bodyHtml: '<p>The boil water notice for Cedar Ridge has ended.</p>',
      },
      es: {
        title: 'Aviso de hervir el agua (terminado)',
        summary: 'El aviso de hervir el agua para Cedar Ridge terminó.',
        bodyHtml: '<p>El aviso de hervir el agua para Cedar Ridge terminó.</p>',
      },
    },
  },
];

/**
 * Signed data-sharing agreements from the county to its partners (layer 1
 * table, layer 3 use): the organization type the resident consents to and
 * the service that fixes the minimum fields (NED-03/04).
 */
export const agreements = [
  {
    partner: 'cleanup',
    orgType: 'volunteer_cleanup',
    service: 'cleanup',
    categories: ['contact', 'location_exact'],
  },
  {
    partner: 'canteen',
    orgType: 'relief_agencies',
    service: 'feeding',
    categories: ['location_exact', 'household'],
  },
  {
    partner: 'shelter-ngo',
    orgType: 'relief_agencies',
    service: 'shelter',
    categories: ['contact', 'access_needs'],
  },
  { partner: 'legal', orgType: 'relief_agencies', service: 'legal', categories: ['contact'] },
  { partner: 'coad', orgType: 'community_groups', service: 'coordination', categories: [] },
];

/**
 * Field roster for the exercise (layer 4 task A; DSP-02, PER-01, FL:FR-13):
 * teams and units with members and recorded credentials. Every person is
 * invented; names come from the fiction lists above with a seed of their own
 * so the roster is stable whatever the report count.
 */
export type CredentialKind =
  | 'damage_assessor'
  | 'chainsaw'
  | 'spanish_speaker'
  | 'chaplain'
  | 'ham_operator'
  | 'medical'
  | 'cert'
  | 'driver_cdl'
  | 'heavy_equipment'
  | 'shelter_management'
  | 'food_safety'
  | 'child_safeguarding'
  | 'mental_health_first_aid'
  | 'background_check';

export interface RosterMember {
  key: string;
  name: string;
  role: 'lead' | 'member' | 'driver' | 'operator' | 'medic';
  operationalRole: string;
  credentials: CredentialKind[];
  hoursLimit: number;
}

export interface TeamSpec {
  key: string;
  tenant: string;
  name: string;
  kind: 'team' | 'unit' | 'canteen' | 'crew' | 'strike_team' | 'net';
  /** Agency name when the organization has no tenant of its own (DSP-09). */
  agency?: string;
  callsign?: string;
  skills: CredentialKind[];
  equipment: string[];
  checkInIntervalMinutes: number;
  members: RosterMember[];
}

interface TeamShape {
  key: string;
  tenant: string;
  name: string;
  kind: TeamSpec['kind'];
  agency?: string;
  callsign?: string;
  skills: CredentialKind[];
  equipment: string[];
  checkInIntervalMinutes?: number;
  size: number;
  operationalRole: string;
  /** Credentials every member holds, then extras for some members. */
  everyone: CredentialKind[];
  some?: CredentialKind[];
}

const teamShapes: TeamShape[] = [
  ...[1, 2, 3, 4].map((n): TeamShape => ({
    key: `da-${n}`,
    tenant: 'county',
    name: `Damage Assessment Team ${n}`,
    kind: 'team',
    callsign: `DA-${n}`,
    skills: ['damage_assessor'],
    equipment: ['tablet', 'laser measure'],
    size: 3,
    operationalRole: 'damage_assessor',
    everyone: ['damage_assessor'],
    some: ['spanish_speaker'],
  })),
  {
    key: 'cert-canvass',
    tenant: 'county',
    name: 'CERT Canvass Team',
    kind: 'team',
    callsign: 'CERT-1',
    skills: ['cert', 'spanish_speaker'],
    equipment: ['tablets', 'door hangers'],
    size: 4,
    operationalRole: 'canvasser',
    everyone: ['cert', 'background_check'],
    some: ['spanish_speaker', 'mental_health_first_aid'],
  },
  {
    key: 'guard-tc-1',
    tenant: 'county',
    name: 'Guard Traffic Control Unit 1',
    kind: 'unit',
    agency: 'Missouri National Guard (exercise)',
    callsign: 'TC-1',
    skills: ['driver_cdl'],
    equipment: ['2 LMTVs', 'traffic cones', 'barricades'],
    size: 6,
    operationalRole: 'guard_unit',
    everyone: ['driver_cdl'],
    some: ['medical'],
  },
  {
    key: 'ares-net',
    tenant: 'county',
    name: 'ARES net control',
    kind: 'net',
    agency: 'Westwind County ARES (exercise)',
    callsign: 'NET',
    skills: ['ham_operator'],
    equipment: ['VHF base station', 'go-kit'],
    checkInIntervalMinutes: 120,
    size: 2,
    operationalRole: 'net_control',
    everyone: ['ham_operator'],
  },
  {
    key: 'chainsaw-a',
    tenant: 'cleanup',
    name: 'Chainsaw Team A',
    kind: 'crew',
    callsign: 'SAW-A',
    skills: ['chainsaw'],
    equipment: ['3 chainsaws', 'pickup with trailer', 'chaps and helmets'],
    size: 4,
    operationalRole: 'cleanup_crew',
    everyone: ['chainsaw', 'background_check'],
    some: ['heavy_equipment', 'medical'],
  },
  {
    key: 'chainsaw-b',
    tenant: 'cleanup',
    name: 'Chainsaw Team B',
    kind: 'crew',
    callsign: 'SAW-B',
    skills: ['chainsaw'],
    equipment: ['4 chainsaws', 'skid steer', 'chaps and helmets'],
    size: 5,
    operationalRole: 'cleanup_crew',
    everyone: ['chainsaw', 'background_check'],
    some: ['heavy_equipment', 'spanish_speaker'],
  },
  ...[1, 2].map((n): TeamShape => ({
    key: `canteen-${n}`,
    tenant: 'canteen',
    name: `Canteen ${n}`,
    kind: 'canteen',
    callsign: `CANTEEN-${n}`,
    skills: ['food_safety'],
    equipment: ['canteen truck', 'cambro set', 'hand-wash station'],
    size: 3,
    operationalRole: 'canteen_staff',
    everyone: ['food_safety', 'background_check'],
    some: ['spanish_speaker', 'chaplain', 'driver_cdl'],
  })),
  {
    key: 'shelter-gym-staff',
    tenant: 'shelter-ngo',
    name: 'Harmon gym shelter staff',
    kind: 'team',
    skills: ['shelter_management'],
    equipment: ['registration tablets', 'wristband printer'],
    checkInIntervalMinutes: 240,
    size: 4,
    operationalRole: 'shelter_worker',
    everyone: ['shelter_management', 'background_check'],
    some: ['child_safeguarding', 'spanish_speaker', 'medical'],
  },
  {
    key: 'coad-outreach',
    tenant: 'coad',
    name: 'COAD outreach pair',
    kind: 'team',
    skills: ['spanish_speaker'],
    equipment: ['resource cards'],
    size: 2,
    operationalRole: 'outreach',
    everyone: ['background_check'],
    some: ['spanish_speaker', 'chaplain'],
  },
  // The stack and browser suites sign in as this team's lead (FIELD_ACCOUNTS); kept apart so
  // their check-ins, positions and timers never touch the rosters the other suites check.
  {
    key: 'field-exercise',
    tenant: 'county',
    name: 'Field Exercise Team',
    kind: 'team',
    callsign: 'FX-1',
    skills: ['cert'],
    equipment: ['radio'],
    size: 2,
    operationalRole: 'canvasser',
    everyone: ['cert'],
  },
];

/**
 * Field accounts (layer 4 task L): a sign-in for a roster person, so the field app and the
 * stack suite act as a real team member. Synthetic like everything here (SCL-12).
 */
export const FIELD_ACCOUNTS = [
  { email: 'rowan.field@example.org', team: 'field-exercise', member: 'lead' },
] as const;

function rosterTeams(rng: Rng): TeamSpec[] {
  const usedNames = new Set<string>();
  const freshName = (): string => {
    for (let i = 0; i < 200; i++) {
      const name = fictionalName(rng);
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    throw new Error('ran out of fictional names');
  };
  return teamShapes.map((shape) => {
    const members: RosterMember[] = [];
    for (let i = 0; i < shape.size; i++) {
      const extras = (shape.some ?? []).filter((_, j) => (i + j) % 2 === 0);
      members.push({
        key: `${shape.key}-${i + 1}`,
        name: freshName(),
        role:
          i === 0
            ? 'lead'
            : shape.kind === 'net'
              ? 'operator'
              : shape.everyone.includes('driver_cdl') && i === 1
                ? 'driver'
                : 'member',
        operationalRole: shape.operationalRole,
        credentials: [...new Set([...shape.everyone, ...extras])],
        hoursLimit: shape.kind === 'net' ? 8 : 12,
      });
    }
    return {
      key: shape.key,
      tenant: shape.tenant,
      name: shape.name,
      kind: shape.kind,
      ...(shape.agency ? { agency: shape.agency } : {}),
      ...(shape.callsign ? { callsign: shape.callsign } : {}),
      skills: shape.skills,
      equipment: shape.equipment,
      checkInIntervalMinutes: shape.checkInIntervalMinutes ?? 60,
      members,
    };
  });
}

/** The exercise roster: stable across runs (its own seed), every name fictional. */
export const teams: TeamSpec[] = rosterTeams(new Rng(4040));

/** FLD-03: the event code typed into the field app at check-in. */
export const EXERCISE_CHECK_IN_CODE = 'WESTWIND';
