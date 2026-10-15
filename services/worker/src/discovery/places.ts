/**
 * Places found by resource discovery (layer-7 task F; REC-13, REC-10). Pure
 * functions, no I/O:
 *
 * - reading a county's own feeds: an HSDS (Open Referral) location list, a
 *   CSV export from an open-data portal, or a GeoJSON point layer;
 * - the kind of place, from its name and type words, never guessed beyond
 *   them ("other" when nothing fits);
 * - the fingerprint (name and ZIP code, or the registered place and the
 *   change) and the content hash, so a rejected candidate is proposed again
 *   only when something about it changes;
 * - the pre-check against the registry criteria, with the same rules the
 *   recommendations use: for each use, whether the place fits, needs
 *   information first, or does not fit, and why.
 *
 * Only what a source states is kept; everything else is unknown.
 */
import { createHash } from 'node:crypto';
import { parseCsv } from '@cg/refdata';
import {
  PLANNING_DEFAULTS,
  feedingFilters,
  marcFilters,
  podFilters,
  shelterFilters,
  type Candidate,
} from '@cg/reporting';

export type FacilityKind =
  | 'school'
  | 'place_of_worship'
  | 'community_center'
  | 'parking_lot'
  | 'government'
  | 'commercial'
  | 'other';

export interface Address {
  line1: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
}

/** What the registry can hold; each is set only when a source states it. */
export interface KnownAttributes {
  sqft?: number;
  ada?: boolean;
  powerBackup?: 'none' | 'generator' | 'transfer_switch';
  kitchen?: boolean;
  showers?: number;
  petPolicy?: 'none' | 'service_animals' | 'pets_inside' | 'pets_outside_area';
  parkingSpaces?: number;
  truckAccess?: boolean;
  /** Words only: opening hours as the source gives them. */
  hours?: string;
  phone?: string;
  website?: string;
}

export interface FoundPlace {
  name: string;
  kind: FacilityKind;
  address: Address | null;
  position: { lat: number; lon: number } | null;
  attributes: KnownAttributes;
  sourceLinks: string[];
  /** For a change to a registered place: what changed, in words. */
  note?: string;
  change?: 'new' | 'update' | 'closed';
  /** The registered place a change is about. */
  facilityId?: string;
}

/** The registry attributes a place may still be missing (REC-10). */
export const REGISTRY_FIELDS: (keyof KnownAttributes)[] = [
  'sqft',
  'ada',
  'powerBackup',
  'kitchen',
  'showers',
  'petPolicy',
  'parkingSpaces',
  'truckAccess',
];

export const unknownOf = (a: KnownAttributes) =>
  REGISTRY_FIELDS.filter((k) => a[k] === undefined).map((k) =>
    k.replace(/([A-Z])/g, ' $1').toLowerCase(),
  );

const RULES: [RegExp, FacilityKind][] = [
  [/\b(parking|park and ride|lot)\b/i, 'parking_lot'],
  [/\b(school|elementary|middle|high school|academy|college|university|campus)\b/i, 'school'],
  [
    /\b(church|iglesia|chapel|temple|mosque|masjid|synagogue|parish|ministr(y|ies)|congregation|cathedral|worship)\b/i,
    'place_of_worship',
  ],
  [
    /\b(community cent(er|re)|recreation|rec cent(er|re)|civic cent(er|re)|senior cent(er|re)|ymca|ywca|boys and girls club|fellowship hall)\b/i,
    'community_center',
  ],
  [/\b(city hall|county|courthouse|fire station|library|armory|fairgrounds?)\b/i, 'government'],
  [/\b(store|market|mall|hotel|motel|inc\.?|llc)\b/i, 'commercial'],
];

/** The kind of place from its name and type words; "other" when nothing fits. */
export function kindFromText(...texts: (string | null | undefined)[]): FacilityKind {
  const t = texts.filter(Boolean).join(' ');
  for (const [re, kind] of RULES) if (re.test(t)) return kind;
  return 'other';
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|of|inc|llc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The same place from two sources has the same fingerprint. */
export function fingerprintOf(p: FoundPlace): string {
  if (p.facilityId && p.change && p.change !== 'new') return `change:${p.facilityId}:${p.change}`;
  const where = (p.address?.postal ?? '').slice(0, 5) || norm(p.address?.city ?? '') || 'nowhere';
  return `place:${norm(p.name)}|${where}`;
}

/** Changes to this mean "something changed" and bring a rejected candidate back. */
export function contentHashOf(p: FoundPlace): string {
  const stable = {
    name: p.name.trim(),
    kind: p.kind,
    address: p.address,
    position: p.position
      ? { lat: Math.round(p.position.lat * 1e4) / 1e4, lon: Math.round(p.position.lon * 1e4) / 1e4 }
      : null,
    attributes: Object.fromEntries(
      Object.entries(p.attributes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    change: p.change ?? 'new',
    note: p.note ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// ---------------------------------------------------------------- pre-check against the registry criteria

export type Fit = 'fits' | 'needs_information' | 'does_not_fit';
export interface PrecheckEntry {
  fit: Fit;
  reasons: string[];
}
export type Precheck = Record<'shelter' | 'feeding' | 'pod' | 'marc', PrecheckEntry>;

/** A MARC of ten partner tables, for the pre-check before any event sizes one. */
const MARC_TABLES = 10;

export function precheck(p: FoundPlace): Precheck {
  const a = p.attributes;
  const c: Candidate = {
    id: 'candidate',
    name: p.name,
    kind: p.kind,
    position: p.position,
    sqft: a.sqft ?? null,
    ada: a.ada ?? null,
    powerBackup: a.powerBackup ?? null,
    kitchen: a.kitchen ?? null,
    showers: a.showers ?? null,
    petPolicy: a.petPolicy ?? null,
    floodplain: null,
    mouStatus: 'none',
    parkingSpaces: a.parkingSpaces ?? null,
    truckAccess: a.truckAccess ?? null,
    lastConfirmedAt: new Date(0),
    inDamageArea: false,
    inFloodZone: false,
    inOutage: false,
    blockedRoad: false,
    inDebrisArea: false,
  };
  const sqftNeeded =
    PLANNING_DEFAULTS.marcBaseSqft + MARC_TABLES * PLANNING_DEFAULTS.marcSqftPerTable;
  const judge = (reasons: string[]): PrecheckEntry => ({
    fit: !reasons.length
      ? 'fits'
      : reasons.every((r) => /unknown/.test(r))
        ? 'needs_information'
        : 'does_not_fit',
    reasons,
  });
  return {
    shelter: judge(shelterFilters(c)),
    feeding: judge(feedingFilters(c)),
    pod: judge(podFilters(c, PLANNING_DEFAULTS)),
    marc: judge(marcFilters(c, sqftNeeded, MARC_TABLES)),
  };
}

// ---------------------------------------------------------------- reading a county's feeds

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim()
    ? v.trim().slice(0, 300)
    : typeof v === 'number'
      ? String(v)
      : null;
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const position = (lat: unknown, lon: unknown) => {
  const y = num(lat);
  const x = num(lon);
  return y !== null && x !== null && Math.abs(y) <= 90 && Math.abs(x) <= 180 && (y !== 0 || x !== 0)
    ? { lat: y, lon: x }
    : null;
};
const httpsLink = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};

/** At most this many places from one feed in one run. */
export const MAX_PLACES_PER_FEED = 2000;

/** HSDS 3 (Open Referral): `/locations` as a list, or a page `{ contents: [...] }`. */
export function placesFromHsds(json: unknown, feedUrl: string): FoundPlace[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as Obj)['contents'])
      ? ((json as Obj)['contents'] as unknown[])
      : [];
  const out: FoundPlace[] = [];
  for (const raw of list.slice(0, MAX_PLACES_PER_FEED)) {
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as Obj;
    const name = str(l['name']);
    if (!name) continue;
    const addr = (Array.isArray(l['addresses']) ? (l['addresses'] as Obj[]) : [])
      .filter((a) => a && typeof a === 'object')
      .sort((a, b) =>
        String(a['address_type'] ?? '') === 'physical'
          ? -1
          : String(b['address_type'] ?? '') === 'physical'
            ? 1
            : 0,
      )[0];
    const access = Array.isArray(l['accessibility']) ? (l['accessibility'] as Obj[]) : [];
    const accessText = access
      .map((x) => `${str(x['description']) ?? ''} ${str(x['details']) ?? ''}`)
      .join(' ');
    const attributes: KnownAttributes = {};
    if (/wheelchair|ada\b|accessible/i.test(accessText)) attributes.ada = true;
    const website = httpsLink(l['url']) ?? httpsLink(l['website']);
    if (website) attributes.website = website;
    const id = str(l['id']);
    out.push({
      name,
      kind: kindFromText(name, str(l['location_type']), str(l['description'])),
      address: addr
        ? {
            line1: str(addr['address_1']),
            city: str(addr['city']),
            state: str(addr['state_province']),
            postal: str(addr['postal_code']),
          }
        : null,
      position: position(l['latitude'], l['longitude']),
      attributes,
      sourceLinks: [id ? `${feedUrl.replace(/\/+$/, '')}#${encodeURIComponent(id)}` : feedUrl],
    });
  }
  return out;
}

/** GeoJSON points with a name property. */
export function placesFromGeoJson(json: unknown, feedUrl: string): FoundPlace[] {
  const features =
    json && typeof json === 'object' && Array.isArray((json as Obj)['features'])
      ? ((json as Obj)['features'] as Obj[])
      : [];
  const out: FoundPlace[] = [];
  for (const f of features.slice(0, MAX_PLACES_PER_FEED)) {
    const props = (f?.['properties'] ?? {}) as Obj;
    const geom = (f?.['geometry'] ?? {}) as Obj;
    const name = str(props['name'] ?? props['NAME'] ?? props['Name'] ?? props['facility_name']);
    if (!name) continue;
    const coords =
      geom['type'] === 'Point' && Array.isArray(geom['coordinates'])
        ? (geom['coordinates'] as unknown[])
        : null;
    out.push(fromRecord(name, props, coords ? position(coords[1], coords[0]) : null, feedUrl));
  }
  return out;
}

/** An open-data CSV with a header row; common column names are recognised. */
export function placesFromCsv(text: string, feedUrl: string): FoundPlace[] {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_'),
  );
  const out: FoundPlace[] = [];
  for (const r of rows.slice(1, MAX_PLACES_PER_FEED + 1)) {
    const rec: Obj = {};
    header.forEach((h, i) => (rec[h] = r[i]));
    const name = str(
      rec['name'] ?? rec['facility_name'] ?? rec['site_name'] ?? rec['location_name'],
    );
    if (!name) continue;
    out.push(
      fromRecord(
        name,
        rec,
        position(
          rec['latitude'] ?? rec['lat'] ?? rec['y'],
          rec['longitude'] ?? rec['lon'] ?? rec['long'] ?? rec['x'],
        ),
        feedUrl,
      ),
    );
  }
  return out;
}

const yes = (v: unknown) => {
  const s = str(v)?.toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1'
    ? true
    : s === 'no' || s === 'n' || s === 'false' || s === '0'
      ? false
      : undefined;
};

function fromRecord(
  name: string,
  rec: Obj,
  pos: { lat: number; lon: number } | null,
  feedUrl: string,
): FoundPlace {
  const g = (...keys: string[]) => {
    for (const k of keys) {
      const v = rec[k] ?? rec[k.toUpperCase()];
      if (str(v)) return v;
    }
    return undefined;
  };
  const attributes: KnownAttributes = {};
  const sqft = num(g('sqft', 'sq_ft', 'square_feet', 'square_footage'));
  if (sqft !== null && sqft > 0) attributes.sqft = Math.round(sqft);
  const ada = yes(g('ada', 'ada_accessible', 'wheelchair', 'accessible'));
  if (ada !== undefined) attributes.ada = ada;
  const kitchen = yes(g('kitchen'));
  if (kitchen !== undefined) attributes.kitchen = kitchen;
  const gen = yes(g('generator', 'backup_power'));
  if (gen !== undefined) attributes.powerBackup = gen ? 'generator' : 'none';
  const parking = num(g('parking', 'parking_spaces'));
  if (parking !== null && parking >= 0) attributes.parkingSpaces = Math.round(parking);
  const hours = str(g('hours', 'opening_hours'));
  if (hours) attributes.hours = hours;
  const website = httpsLink(g('website', 'url'));
  if (website) attributes.website = website;
  return {
    name,
    kind: kindFromText(name, str(g('type', 'category', 'facility_type', 'kind'))),
    address: {
      line1: str(g('address', 'street', 'address_1', 'street_address')),
      city: str(g('city', 'municipality')),
      state: str(g('state')),
      postal: str(g('zip', 'zipcode', 'zip_code', 'postal', 'postal_code')),
    },
    position: pos,
    attributes,
    sourceLinks: [feedUrl],
  };
}

/** Reads one feed by its kind; malformed content yields no places, never a guess. */
export function placesFromFeed(
  kind: 'hsds' | 'csv' | 'geojson',
  body: string,
  feedUrl: string,
): FoundPlace[] {
  if (kind === 'csv') return placesFromCsv(body, feedUrl);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  return kind === 'hsds' ? placesFromHsds(json, feedUrl) : placesFromGeoJson(json, feedUrl);
}
