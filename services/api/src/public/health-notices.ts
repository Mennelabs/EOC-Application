/**
 * Health notices on the public "Find help" page (FL:FR-06, PUB-07): every
 * notice in force (approved, not ended, not past its expiry), in the asked
 * language when public health wrote one, else English. A notice whose area
 * holds the visitor's ZIP code or point comes first and says it is for their
 * area. Only what public health wrote for the public is shown.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import type { Near } from './sites-view.ts';

export interface PublicHealthNotice {
  id: string;
  kind: 'boil_water' | 'do_not_use_water' | 'safety';
  title: string;
  body: string;
  lang: 'en' | 'es';
  areaLabel: string;
  zips: string[];
  since: string;
  expiresAt: string | null;
  /** The visitor's ZIP code or point is inside the notice's area. */
  here: boolean;
}

export async function publicHealthNotices(
  trx: Transaction<Database>,
  tenantId: string,
  lang: 'en' | 'es',
  near: Near | null,
): Promise<PublicHealthNotice[]> {
  // A typed ZIP code counts even when the page could not place it on the map.
  const zip = near ? (/^\s*(\d{5})(?:-\d{4})?\s*$/.exec(near.query)?.[1] ?? null) : null;
  const point =
    near?.resolved && near.lat !== null && near.lon !== null
      ? sql`ST_SetSRID(ST_MakePoint(${near.lon}, ${near.lat}), 4326)::geography`
      : null;
  const rows = await trx
    .selectFrom('cg.health_notice')
    .select([
      'id',
      'kind',
      'title_en',
      'body_en',
      'title_es',
      'body_es',
      'area_label',
      'zips',
      'approved_at',
      'expires_at',
      sql<boolean>`(${zip}::text is not null and ${zip}::text = any(zips)) or (${
        point
          ? sql`center is not null and ST_DWithin(center::geography, ${point}, radius_m)`
          : sql`false`
      })`.as('here'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .orderBy('approved_at', 'desc')
    .execute();
  return rows
    .map((r) => {
      const es = lang === 'es' && r.title_es && r.body_es;
      return {
        id: r.id,
        kind: r.kind,
        title: es ? r.title_es! : r.title_en,
        body: es ? r.body_es! : r.body_en,
        lang: (es ? 'es' : 'en') as 'en' | 'es',
        areaLabel: r.area_label,
        zips: r.zips,
        since: r.approved_at!.toISOString(),
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
        here: Boolean(r.here),
      };
    })
    .sort((a, b) => Number(b.here) - Number(a.here));
}
