/**
 * What the shelter recommendation reads (layer-7 task E; REC-02, REC-10,
 * REC-11): the approved facilities with their location, the live conditions
 * at each (major or destroyed homes within 250 m, a high-risk flood zone, a
 * road blockage reported within 200 m of its radius, an outage still open
 * that names its town or ZIP code), the demand from the event's open needs,
 * the Census tracts with their profile, and the age of each input. All of it
 * runs in the caller's transaction, under the tenant's row security.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { currentSnapshot } from './area.ts';
import {
  PLANNING_DEFAULTS,
  inputAge,
  type Candidate,
  type Demand,
  type InputAge,
  type PlanningFactors,
  type Tract,
} from './recommend.ts';

type Trx = Transaction<Database>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export interface ShelterInputs {
  candidates: Candidate[];
  demand: Demand;
  tracts: Tract[];
  inputs: InputAge[];
}

export async function loadShelterInputs(
  trx: Trx,
  tenantId: string,
  eventId: string,
  now = new Date(),
  factors: PlanningFactors = PLANNING_DEFAULTS,
): Promise<ShelterInputs> {
  const flood = await currentSnapshot(trx, tenantId, 'flood_zone');
  const rows = (
    await sql<{
      id: string;
      name: string;
      kind: string;
      lat: number | null;
      lon: number | null;
      city: string | null;
      postal: string | null;
      sqft: number | null;
      ada: boolean | null;
      power_backup: Candidate['powerBackup'];
      kitchen: boolean | null;
      showers: number | null;
      pet_policy: Candidate['petPolicy'];
      floodplain: Candidate['floodplain'];
      mou_status: Candidate['mouStatus'];
      last_confirmed_at: Date;
      damaged: boolean;
      flooded: boolean;
      blocked: boolean;
      outage: boolean;
    }>`
      select f.id, f.name, f.kind, f.sqft, f.ada, f.power_backup, f.kitchen, f.showers,
        f.pet_policy, f.floodplain, f.mou_status, f.last_confirmed_at, l.city, l.postal,
        st_y(l.geom::geometry) as lat, st_x(l.geom::geometry) as lon,
        exists (
          select 1 from cg.report r join cg.location rl on rl.id = r.location_id
          where r.event_id = ${eventId}::uuid and r.withdrawn_at is null
            and r.fema_degree in ('destroyed', 'major') and l.geom is not null and rl.geom is not null
            and st_dwithin(rl.geom::geography, l.geom::geography, 250)
        ) as damaged,
        ${
          flood
            ? sql`exists (
          select 1 from cg.ref_flood_zone z
          where z.snapshot_id = ${flood.id}::uuid and z.zone ~ '^(A|V)'
            and l.geom is not null and st_intersects(z.geom, l.geom::geometry)
        )`
            : sql`false`
        } as flooded,
        exists (
          select 1 from cg.hazard h
          where h.event_id = ${eventId}::uuid and h.kind = 'blocked_road'
            and h.state in ('reported', 'confirmed') and h.cleared_at is null
            and h.geom is not null and l.geom is not null
            and st_dwithin(h.geom::geography, l.geom::geography, coalesce(h.radius_m, 0) + 200)
        ) as blocked,
        exists (
          select 1 from cg.outage o
          where o.event_id = ${eventId}::uuid and o.restored_at is null
            and (
              (l.postal is not null and o.area ilike '%' || l.postal || '%')
              or (l.city is not null and o.area ilike '%' || l.city || '%')
              or o.facility_name ilike f.name
            )
        ) as outage
      from cg.facility f
      left join cg.location l on l.id = f.location_id
      where f.tenant_id = ${tenantId}::uuid and f.status = 'approved'
      order by f.id`.execute(trx)
  ).rows;
  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    position: r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
    sqft: r.sqft,
    ada: r.ada,
    powerBackup: r.power_backup,
    kitchen: r.kitchen,
    showers: r.showers,
    petPolicy: r.pet_policy,
    floodplain: r.floodplain,
    mouStatus: r.mou_status,
    lastConfirmedAt: new Date(r.last_confirmed_at),
    inDamageArea: r.damaged,
    inFloodZone: r.flooded,
    inOutage: r.outage,
    blockedRoad: r.blocked,
  }));

  // ---------------------------------------------------------------- demand (open needs)
  const d = (
    await sql<{ households: string; pets: string; lat: number | null; lon: number | null }>`
      select count(*) filter (where n.category = 'shelter_tonight') as households,
        count(*) filter (where n.category = 'pets') as pets,
        avg(st_y(l.geom::geometry)) filter (where n.category = 'shelter_tonight') as lat,
        avg(st_x(l.geom::geometry)) filter (where n.category = 'shelter_tonight') as lon
      from cg.need n
      left join cg.report r on r.id = n.report_id
      left join cg.location l on l.id = coalesce(n.location_id, r.location_id)
      where n.tenant_id = ${tenantId}::uuid and n.event_id = ${eventId}::uuid
        and n.status in ('open', 'claimed', 'in_progress')`.execute(trx)
  ).rows[0];
  const demand: Demand = {
    households: Number(d?.households ?? 0),
    petHouseholds: Number(d?.pets ?? 0),
    centroid:
      d && d.lat !== null && d.lon !== null ? { lat: Number(d.lat), lon: Number(d.lon) } : null,
  };

  // ---------------------------------------------------------------- tracts with their profile
  const tractSnap = await currentSnapshot(trx, tenantId, 'tract');
  const profileSnap = await currentSnapshot(trx, tenantId, 'tract_profile');
  let tracts: Tract[] = [];
  if (tractSnap) {
    const t = (
      await sql<{
        geoid: string;
        name: string | null;
        lat: number;
        lon: number;
        households: number | null;
        renters: number | null;
        lep: number | null;
        poverty: string | null;
      }>`
        select t.geoid, t.name,
          st_y(st_pointonsurface(t.geom)) as lat, st_x(st_pointonsurface(t.geom)) as lon,
          p.households, p.renter_households as renters, p.limited_english_households as lep,
          p.poverty_pct as poverty
        from cg.ref_tract t
        left join cg.ref_tract_profile p on p.geoid = t.geoid
          ${profileSnap ? sql`and p.snapshot_id = ${profileSnap.id}::uuid` : sql`and false`}
        where t.snapshot_id = ${tractSnap.id}::uuid
        order by t.geoid`.execute(trx)
    ).rows;
    // Income bands as the equity screens make them: fifths by poverty share, highest first.
    const ranked = t
      .filter((x) => x.poverty !== null)
      .sort((a, b) => Number(b.poverty) - Number(a.poverty) || a.geoid.localeCompare(b.geoid));
    const band = new Map<string, number>();
    ranked.forEach((x, i) => band.set(x.geoid, Math.floor((i * 5) / ranked.length) + 1));
    tracts = t.map((x) => {
      const hh = num(x.households);
      const pct = (v: unknown) =>
        hh && num(v) !== null ? Math.round(((num(v) as number) / hh) * 1000) / 10 : null;
      return {
        geoid: x.geoid,
        name: x.name,
        centroid: { lat: Number(x.lat), lon: Number(x.lon) },
        households: hh,
        incomeBand: band.get(x.geoid) ?? null,
        renterSharePct: pct(x.renters),
        limitedEnglishPct: pct(x.lep),
      };
    });
  }

  // ---------------------------------------------------------------- the age of each input (REC-10)
  const oldest = candidates.reduce<Date | null>(
    (m, c) => (m === null || c.lastConfirmedAt < m ? c.lastConfirmedAt : m),
    null,
  );
  const staleEntries = candidates.filter(
    (c) => now.getTime() - c.lastConfirmedAt.getTime() > factors.staleDays * 86_400_000,
  ).length;
  const latest = async (q: Promise<{ rows: { at: Date | null }[] }>) =>
    (await q).rows[0]?.at ?? null;
  const hazardAt = await latest(
    sql<{ at: Date | null }>`select max(reported_at) as at from cg.hazard
      where event_id = ${eventId}::uuid and kind = 'blocked_road'`.execute(trx),
  );
  const outageAt = await latest(
    sql<{ at: Date | null }>`select max(greatest(started_at, updated_at)) as at from cg.outage
      where event_id = ${eventId}::uuid`.execute(trx),
  );
  const inputs: InputAge[] = [
    inputAge(
      'Facility registry (oldest re-check)',
      oldest,
      now,
      factors.staleDays * 24,
      staleEntries
        ? `${staleEntries} entr${staleEntries === 1 ? 'y is' : 'ies are'} past the yearly re-check`
        : undefined,
    ),
    inputAge('Open needs from residents', now, now, 1, 'read live'),
    inputAge(
      'Flood zones (FEMA)',
      flood?.retrieved_at ?? null,
      now,
      24 * 400,
      flood ? undefined : 'not loaded: flood zones are not checked',
    ),
    inputAge(
      'Census tract profile',
      profileSnap?.retrieved_at ?? null,
      now,
      24 * 800,
      profileSnap ? undefined : 'not loaded: coverage cannot be checked',
    ),
    inputAge(
      'Road blockages reported',
      hazardAt,
      now,
      12,
      hazardAt ? undefined : 'none reported for this event',
    ),
    inputAge('Outages', outageAt, now, 12, outageAt ? undefined : 'none logged for this event'),
  ];
  return { candidates, demand, tracts, inputs };
}
