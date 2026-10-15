/**
 * Representative photos for the IDA package (layer-6 task F; DCL:DEC-13,
 * PHO-06, PHO-07, PHO-08). A photo can go in only when its metadata is
 * stripped and a detector blurred its faces, plates and documents (the
 * photo pipeline marks this `blur_status = 'applied'`; anything else stays
 * restricted), and only the blurred review image leaves. Its place is
 * generalized like a home's on the street sheet: the 100 m grid cell, ZIP,
 * tract and jurisdiction, or the public site's name. The API and the worker
 * both read photos through here, so the rule is checked when a person
 * chooses a photo and again when the package is built.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { toUsng } from '@cg/field-core';

type Trx = Transaction<Database>;

export interface PhotoPlace {
  usng: string | null;
  postal: string | null;
  tract: string | null;
  jurisdiction: string | null;
  /** A public damage site's name; null for a home. */
  site: string | null;
}

export interface EventPhoto {
  photoId: string;
  subject: 'home' | 'public_site';
  recordKind: 'report' | 'assessment' | 'pa_site';
  recordId: string;
  /** Metadata stripped and sensitive regions blurred: fit to leave the platform. */
  cleared: boolean;
  reviewKey: string | null;
  place: PhotoPlace;
  /** For a scoped package: the home's jurisdiction or the site's applicant. */
  jurisdictionTenantId: string | null;
  takenOrUploadedAt: string | null;
}

export interface PackagePhoto {
  choiceId: string;
  photoId: string;
  reviewKey: string;
  caption: string;
  subject: EventPhoto['subject'];
  place: PhotoPlace;
}

/** The most chosen photos a package carries (two to a PDF page). */
export const MAX_PACKAGE_PHOTOS = 24;

/** "15S XX 12345 67890 (100 m cell) · ZIP 63399 · tract 29999000100 · Harmon City" */
export function placeText(p: PhotoPlace): string {
  const parts = [
    p.site ? `Site: ${p.site}` : null,
    p.usng ? `${p.usng} (${p.site ? '10 m' : '100 m'} cell)` : null,
    p.postal ? `ZIP ${p.postal}` : null,
    p.tract ? `tract ${p.tract}` : null,
    p.jurisdiction,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : 'Place unknown';
}

/** Every photo attached to the event's reports, field assessments and public damage sites. */
export async function eventPhotos(
  trx: Trx,
  eventId: string,
  opts: { photoIds?: string[] } = {},
): Promise<EventPhoto[]> {
  if (opts.photoIds && opts.photoIds.length === 0) return [];
  const rows = await sql<{
    id: string;
    report_id: string | null;
    field_record_type: string | null;
    field_record_id: string | null;
    status: string;
    blur_status: string;
    exif_stripped: boolean;
    derivative_keys: Record<string, string> | null;
    at: Date | null;
    lat: number | null;
    lon: number | null;
    postal: string | null;
    tract: string | null;
    jurisdiction: string | null;
    jurisdiction_tenant_id: string | null;
    site_name: string | null;
    applicant_tenant_id: string | null;
    site_lat: number | null;
    site_lon: number | null;
  }>`
    select p.id, p.report_id, p.field_record_type, p.field_record_id, p.status, p.blur_status,
      p.exif_stripped, p.derivative_keys, coalesce(p.suggested_taken_at, p.uploaded_at) as at,
      ST_Y(coalesce(a.geom, l.geom)) as lat, ST_X(coalesce(a.geom, l.geom)) as lon,
      l.postal, g.tract_geoid as tract, j.name as jurisdiction,
      g.jurisdiction_tenant_id,
      s.name as site_name, s.applicant_tenant_id,
      ST_Y(s.geom) as site_lat, ST_X(s.geom) as site_lon
    from cg.photo p
    left join cg.report r on r.id = p.report_id
    left join cg.field_assessment a
      on p.field_record_type = 'field_assessment' and a.id = p.field_record_id
    left join cg.pa_site s on p.field_record_type = 'pa_site' and s.id = p.field_record_id
    left join cg.location l on l.id = coalesce(r.location_id, a.location_id)
    left join cg.location_geo g on g.location_id = l.id
    left join cg.tenant j on j.id = g.jurisdiction_tenant_id
    where coalesce(r.event_id, a.event_id, s.event_id) = ${eventId}::uuid
      and (p.report_id is not null or p.field_record_type in ('field_assessment', 'pa_site'))
      ${opts.photoIds ? sql`and p.id = any(${opts.photoIds}::uuid[])` : sql``}
    order by p.created_at`.execute(trx);
  return rows.rows.map((r) => {
    const site = r.field_record_type === 'pa_site';
    const kind = r.report_id ? 'report' : site ? 'pa_site' : 'assessment';
    const lat = site ? r.site_lat : r.lat;
    const lon = site ? r.site_lon : r.lon;
    const reviewKey = r.derivative_keys?.['review'] ?? null;
    return {
      photoId: r.id,
      subject: site ? 'public_site' : 'home',
      recordKind: kind,
      recordId: (r.report_id ?? r.field_record_id)!,
      cleared:
        r.status === 'processed' &&
        r.blur_status === 'applied' &&
        r.exif_stripped &&
        reviewKey !== null,
      reviewKey,
      place: {
        usng: lat !== null && lon !== null ? toUsng(Number(lat), Number(lon), site ? 4 : 3) : null,
        postal: site ? null : r.postal,
        tract: site ? null : r.tract,
        jurisdiction: site ? null : r.jurisdiction,
        site: site ? r.site_name : null,
      },
      jurisdictionTenantId: site ? r.applicant_tenant_id : r.jurisdiction_tenant_id,
      takenOrUploadedAt: r.at ? r.at.toISOString() : null,
    } satisfies EventPhoto;
  });
}

/**
 * The chosen photos that go in a package: still cleared, and their home or
 * site in the package's scope. The rest are counted as left out, and the
 * README says so.
 */
export async function packagePhotos(
  trx: Trx,
  eventId: string,
  scope: { recordIds: ReadonlySet<string>; siteIds: ReadonlySet<string> },
): Promise<{ photos: PackagePhoto[]; leftOut: number }> {
  const chosen = await trx
    .selectFrom('cg.package_photo')
    .select(['id', 'photo_id', 'caption'])
    .where('event_id', '=', eventId)
    .where('removed_at', 'is', null)
    .orderBy('chosen_at')
    .orderBy('id')
    .limit(MAX_PACKAGE_PHOTOS)
    .execute();
  const found = new Map(
    (await eventPhotos(trx, eventId, { photoIds: chosen.map((c) => c.photo_id) })).map((p) => [
      p.photoId,
      p,
    ]),
  );
  const photos: PackagePhoto[] = [];
  for (const c of chosen) {
    const p = found.get(c.photo_id);
    if (!p || !p.cleared || !p.reviewKey) continue;
    const inScope =
      p.recordKind === 'pa_site' ? scope.siteIds.has(p.recordId) : scope.recordIds.has(p.recordId);
    if (!inScope) continue;
    photos.push({
      choiceId: c.id,
      photoId: p.photoId,
      reviewKey: p.reviewKey,
      caption: c.caption,
      subject: p.subject,
      place: p.place,
    });
  }
  return { photos, leftOut: chosen.length - photos.length };
}
