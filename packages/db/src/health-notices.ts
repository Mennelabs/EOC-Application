/**
 * Who a health notice reaches (FL:FR-06, docs/06 "residents who opt in to
 * updates receive notices ... in their area"): residents whose report (not
 * withdrawn) or help request is in the notice's area, by ZIP code or within
 * its circle. One row per party; the caller decrypts the contact and picks
 * the channel with `noticeChannel`, and the same person reached through two
 * reports is told once (by the contact's blind index).
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from './schema.ts';

export interface NoticeArea {
  tenantId: string;
  zips: readonly string[];
  /** A circle, when the notice has one. */
  lat: number | null;
  lon: number | null;
  radiusM: number | null;
}

export interface NoticeParty {
  party_id: string;
  contact_enc: Buffer | null;
  phone_bidx: Buffer | null;
  email_bidx: Buffer | null;
  sms_opt_in: boolean;
  language: string;
}

export async function partiesInNoticeArea(
  trx: Transaction<Database>,
  area: NoticeArea,
): Promise<NoticeParty[]> {
  const circle =
    area.lat !== null && area.lon !== null && area.radiusM !== null
      ? sql`(l.geom is not null and ST_DWithin(l.geom::geography, ST_SetSRID(ST_MakePoint(${area.lon}, ${area.lat}), 4326)::geography, ${area.radiusM}))`
      : sql`false`;
  const zips = [...area.zips];
  const { rows } = await sql<NoticeParty>`
    with places as (
      select r.reporter_party_id as party_id, r.location_id
        from cg.report r
       where r.tenant_id = ${area.tenantId}
         and r.withdrawn_at is null
         and r.reporter_party_id is not null
         and r.location_id is not null
      union
      select n.contact_party_id, n.location_id
        from cg.need n
       where n.tenant_id = ${area.tenantId}
         and n.contact_party_id is not null
         and n.location_id is not null
    )
    select distinct p.id as party_id, p.contact_enc, p.phone_bidx, p.email_bidx,
           p.sms_opt_in, p.language
      from places x
      join cg.location l on l.id = x.location_id
      join cg.party p on p.id = x.party_id
     where p.contact_enc is not null
       and (left(coalesce(l.postal, ''), 5) = any(${zips}::text[]) or ${circle})
     order by p.id`.execute(trx);
  return rows;
}

/**
 * The channel a notice may use for one resident: a text only to a phone that
 * opted in to texts; otherwise an email only when email is how they asked to
 * be reached. Nothing otherwise (plan reading 30).
 */
export function noticeChannel(
  contact: { phone?: string; email?: string; preferred?: string },
  smsOptIn: boolean,
): { channel: 'sms' | 'email'; to: string } | null {
  if (contact.phone && smsOptIn) return { channel: 'sms', to: contact.phone };
  if (contact.email && contact.preferred === 'email')
    return { channel: 'email', to: contact.email };
  return null;
}
