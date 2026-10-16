/**
 * The public view of sites and resources (PUB-01–05, PUB-18, NED-06): one
 * query every channel reads from, so the web page, the text keyword, the
 * phone line, the feeds and the widget say the same thing. Published,
 * non-confidential, reconfirmed within the tenant's window; nearest first
 * when a place is known; a full or closed site names the next nearest open
 * site of its kind.
 */
import { sql, type Transaction } from 'kysely';
import type { Database, SiteKind } from '@cg/db';

type Trx = Transaction<Database>;

export interface Near {
  query: string;
  resolved: boolean;
  lat: number | null;
  lon: number | null;
  /** How the place was understood: a ZIP centroid, coordinates, or nothing. */
  how: 'zip' | 'point' | 'none';
  label: string | null;
}

export interface PublicSite {
  id: string;
  slug: string;
  kind: string;
  name: string;
  status: 'planned' | 'open' | 'limited' | 'full' | 'closed';
  address: {
    line1: string | null;
    unit: string | null;
    city: string | null;
    state: string | null;
    postal: string | null;
  } | null;
  position: { lat: number; lon: number } | null;
  distanceKm: number | null;
  hours: Record<string, unknown>;
  services: string[];
  pets: 'yes' | 'no' | 'service_animals' | 'unknown';
  accessibility: Record<string, unknown>;
  medicalPower: boolean | null;
  languages: string[];
  transit: string | null;
  directions: string | null;
  lastConfirmedAt: string | null;
  updatedAt: string;
  nextNearest: { id: string; slug: string; name: string; distanceKm: number | null } | null;
}

export interface PublicResource {
  id: string;
  slug: string;
  type: string;
  category: string;
  ordering: number;
  lang: string;
  title: string;
  summary: string | null;
  referenceUrl: string | null;
  linkStatus: 'unchecked' | 'ok' | 'broken';
  expiresAt: string | null;
  reviewedAt: string | null;
  updatedAt: string;
  /** FR-16.01: names the published thumbnail (it changes with the picture); null when there is none. */
  thumbnail: string | null;
}

/** A short public name for a stored picture: its random part, never the storage path. */
export const thumbnailTag = (key: string | null): string | null =>
  key ? (/thumb-([0-9a-f-]{36})\.jpg$/.exec(key)?.[1]?.slice(0, 8) ?? null) : null;

export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const r = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** A ZIP, "lat,lon", or free text with a ZIP in it; the geocoder (maps profile) comes later (SCL-06). */
export async function resolveNear(
  trx: Trx,
  tenantId: string,
  raw: string | undefined,
): Promise<Near | null> {
  if (!raw || !raw.trim()) return null;
  const query = raw.trim().slice(0, 120);
  const point = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(query);
  if (point) {
    const lat = Number(point[1]);
    const lon = Number(point[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
      return { query, resolved: true, lat, lon, how: 'point', label: null };
  }
  const zip = /\b(\d{5})\b/.exec(query)?.[1];
  if (zip) {
    const row = await trx
      .selectFrom('cg.zip_centroid')
      .select([
        'postal',
        'name',
        sql<number>`ST_Y(geom)`.as('lat'),
        sql<number>`ST_X(geom)`.as('lon'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('postal', '=', zip)
      .executeTakeFirst();
    if (row)
      return {
        query,
        resolved: true,
        lat: Number(row.lat),
        lon: Number(row.lon),
        how: 'zip',
        label: row.name ? `${row.name} (${row.postal})` : row.postal,
      };
  }
  return { query, resolved: false, lat: null, lon: null, how: 'none', label: null };
}

const iso = (d: Date | string | null | undefined) =>
  d === null || d === undefined ? null : (d instanceof Date ? d : new Date(d)).toISOString();

interface SiteRow {
  id: string;
  slug: string;
  kind: string;
  name: string;
  status: PublicSite['status'];
  hours: unknown;
  services: string[];
  pets: PublicSite['pets'];
  accessibility: unknown;
  medical_power: boolean | null;
  languages: string[];
  transit: string | null;
  directions: string | null;
  last_confirmed_at: Date | null;
  updated_at: Date;
  line1: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  lat: number | string | null;
  lon: number | string | null;
}

/**
 * Published, non-confidential sites still inside their reconfirmation window
 * (PUB-03), with distance from `near` when known, nearest first.
 */
export async function publicSites(
  trx: Trx,
  tenantId: string,
  options: { near?: Near | null; kind?: string | undefined; eventId?: string | undefined } = {},
): Promise<PublicSite[]> {
  let q = trx
    .selectFrom('cg.site as s')
    .leftJoin('cg.location as l', 'l.id', 's.location_id')
    .select([
      's.id',
      's.slug',
      's.kind',
      's.name',
      's.status',
      's.hours',
      's.services',
      's.pets',
      's.accessibility',
      's.medical_power',
      's.languages',
      's.transit',
      's.directions',
      's.last_confirmed_at',
      's.updated_at',
      'l.line1',
      'l.unit',
      'l.city',
      'l.state',
      'l.postal',
      sql<number | null>`ST_Y(l.geom)`.as('lat'),
      sql<number | null>`ST_X(l.geom)`.as('lon'),
    ])
    .where('s.tenant_id', '=', tenantId)
    .where('s.published_at', 'is not', null)
    .where('s.unpublished_at', 'is', null)
    .where('s.confidential', '=', false)
    .where('s.status', '<>', 'planned')
    // PUB-03: not reconfirmed inside the window → hidden on every channel.
    .where(
      sql<boolean>`coalesce(s.last_confirmed_at, s.published_at) + make_interval(hours => s.confirm_every_hours) > now()`,
    )
    .orderBy('s.name');
  if (options.kind) q = q.where('s.kind', '=', options.kind as SiteKind);
  if (options.eventId) q = q.where('s.event_id', '=', options.eventId);
  const rows = (await q.execute()) as SiteRow[];
  const near = options.near?.resolved ? { lat: options.near.lat!, lon: options.near.lon! } : null;
  const sites: PublicSite[] = rows.map((r) => {
    const position =
      r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null;
    return {
      id: r.id,
      slug: r.slug,
      kind: r.kind,
      name: r.name,
      status: r.status,
      address:
        r.line1 || r.city || r.postal
          ? { line1: r.line1, unit: r.unit, city: r.city, state: r.state, postal: r.postal }
          : null,
      position,
      distanceKm: near && position ? Math.round(haversineKm(near, position) * 10) / 10 : null,
      hours: (r.hours ?? {}) as Record<string, unknown>,
      services: r.services,
      pets: r.pets,
      accessibility: (r.accessibility ?? {}) as Record<string, unknown>,
      medicalPower: r.medical_power,
      languages: r.languages,
      transit: r.transit,
      directions: r.directions,
      lastConfirmedAt: iso(r.last_confirmed_at),
      updatedAt: iso(r.updated_at)!,
      nextNearest: null,
    };
  });
  // PUB-04: a full or closed site points to the next nearest open site of its kind.
  for (const s of sites) {
    if (s.status !== 'full' && s.status !== 'closed') continue;
    const candidates = sites.filter(
      (o) => o.id !== s.id && o.kind === s.kind && (o.status === 'open' || o.status === 'limited'),
    );
    const from = s.position;
    const ranked = candidates
      .map((o) => ({
        o,
        d: from && o.position ? haversineKm(from, o.position) : null,
      }))
      .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
    const best = ranked[0];
    s.nextNearest = best
      ? {
          id: best.o.id,
          slug: best.o.slug,
          name: best.o.name,
          distanceKm: best.d === null ? null : Math.round(best.d * 10) / 10,
        }
      : null;
  }
  if (near)
    sites.sort(
      (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.name.localeCompare(b.name),
    );
  return sites;
}

/** Published resources in the language asked for (English text as the fallback), expired ones left out (AC-16B). */
export async function publicResources(
  trx: Trx,
  tenantId: string,
  lang: string,
): Promise<PublicResource[]> {
  const rows = await trx
    .selectFrom('cg.resource as r')
    .innerJoin('cg.resource_text as t', 't.resource_id', 'r.id')
    .select([
      'r.id',
      'r.slug',
      'r.type',
      'r.category',
      'r.ordering',
      'r.reference_url',
      'r.link_status',
      'r.expires_at',
      'r.updated_at',
      'r.published_thumbnail_key',
      't.locale',
      't.title',
      't.summary',
      't.reviewed_at',
    ])
    .where('r.tenant_id', '=', tenantId)
    .where('r.status', '=', 'published')
    .where('r.published_at', 'is not', null)
    .where('r.unpublished_at', 'is', null)
    .where((eb) => eb.or([eb('r.expires_at', 'is', null), eb('r.expires_at', '>', new Date())]))
    .where('t.reviewed_at', 'is not', null) // PUB-06: human-reviewed text only
    .orderBy('r.ordering')
    .orderBy('r.slug')
    .execute();
  const byResource = new Map<string, typeof rows>();
  for (const r of rows) byResource.set(r.id, [...(byResource.get(r.id) ?? []), r]);
  const out: PublicResource[] = [];
  for (const texts of byResource.values()) {
    const text =
      texts.find((t) => t.locale === lang) ?? texts.find((t) => t.locale === 'en') ?? texts[0]!;
    out.push({
      id: text.id,
      slug: text.slug,
      type: text.type,
      category: text.category,
      ordering: text.ordering,
      lang: text.locale,
      title: text.title,
      summary: text.summary,
      referenceUrl: text.reference_url,
      linkStatus: text.link_status,
      expiresAt: iso(text.expires_at),
      reviewedAt: iso(text.reviewed_at),
      updatedAt: iso(text.updated_at)!,
      thumbnail: thumbnailTag(text.published_thumbnail_key),
    });
  }
  return out;
}
