/**
 * What the recommendations read (layer-7 task E; REC-02, REC-05–REC-11): the
 * approved facilities with their location and the live conditions at each
 * (major or destroyed homes within 250 m, a high-risk flood zone, a road
 * blockage or debris reported within 200 m of its radius, an outage still
 * open that names its town, ZIP code or name), the demand from the event's
 * open requests, outages and verified damage, the canteens on the roster, the
 * Census tracts with their profile, and the age of each input. All of it
 * runs in the caller's transaction, under the tenant's row security; only
 * counts and places leave this file, never a resident's details.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { currentSnapshot } from './area.ts';
import { countDamage } from './counting.ts';
import { loadDamageRecords } from './load.ts';
import {
  PLANNING_DEFAULTS,
  inputAge,
  type Candidate,
  type Demand,
  type InputAge,
  type PlanningFactors,
  type Point,
  type Tract,
} from './recommend.ts';
import type { Canteen, DemandCell, MarcDemand, PodDemand } from './recommend-sites.ts';

type Trx = Transaction<Database>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const OPEN = sql`('open', 'claimed', 'in_progress')`;

export interface ShelterInputs {
  candidates: Candidate[];
  demand: Demand;
  tracts: Tract[];
  inputs: InputAge[];
}

/** The approved registry with the live conditions at each place. */
export async function loadCandidates(
  trx: Trx,
  tenantId: string,
  eventId: string,
): Promise<{ candidates: Candidate[]; floodLoadedAt: Date | null; floodLoaded: boolean }> {
  const flood = await currentSnapshot(trx, tenantId, 'flood_zone');
  const near = (kind: string) => sql`exists (
          select 1 from cg.hazard h
          where h.event_id = ${eventId}::uuid and h.kind = ${kind}
            and h.state in ('reported', 'confirmed') and h.cleared_at is null
            and h.geom is not null and l.geom is not null
            and st_dwithin(h.geom::geography, l.geom::geography, coalesce(h.radius_m, 0) + 200)
        )`;
  const rows = (
    await sql<{
      id: string;
      name: string;
      kind: string;
      lat: number | null;
      lon: number | null;
      sqft: number | null;
      ada: boolean | null;
      power_backup: Candidate['powerBackup'];
      kitchen: boolean | null;
      showers: number | null;
      pet_policy: Candidate['petPolicy'];
      floodplain: Candidate['floodplain'];
      mou_status: Candidate['mouStatus'];
      parking_spaces: number | null;
      truck_access: boolean | null;
      last_confirmed_at: Date;
      damaged: boolean;
      flooded: boolean;
      blocked: boolean;
      debris: boolean;
      outage: boolean;
    }>`
      select f.id, f.name, f.kind, f.sqft, f.ada, f.power_backup, f.kitchen, f.showers,
        f.pet_policy, f.floodplain, f.mou_status, f.parking_spaces, f.truck_access,
        f.last_confirmed_at,
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
        ${near('blocked_road')} as blocked,
        ${near('debris')} as debris,
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
  return {
    candidates: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      position:
        r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
      sqft: r.sqft,
      ada: r.ada,
      powerBackup: r.power_backup,
      kitchen: r.kitchen,
      showers: r.showers,
      petPolicy: r.pet_policy,
      floodplain: r.floodplain,
      mouStatus: r.mou_status,
      parkingSpaces: r.parking_spaces,
      truckAccess: r.truck_access,
      lastConfirmedAt: new Date(r.last_confirmed_at),
      inDamageArea: r.damaged,
      inFloodZone: r.flooded,
      inOutage: r.outage,
      blockedRoad: r.blocked,
      inDebrisArea: r.debris,
    })),
    floodLoadedAt: flood?.retrieved_at ?? null,
    floodLoaded: !!flood,
  };
}

/** Census tracts with the profile the equity check and walk-up points need. */
export async function loadTracts(
  trx: Trx,
  tenantId: string,
  eventId: string,
): Promise<{ tracts: Tract[]; profileAt: Date | null; profiled: boolean }> {
  const tractSnap = await currentSnapshot(trx, tenantId, 'tract');
  const profileSnap = await currentSnapshot(trx, tenantId, 'tract_profile');
  if (!tractSnap) return { tracts: [], profileAt: null, profiled: false };
  const t = (
    await sql<{
      geoid: string;
      name: string | null;
      lat: number;
      lon: number;
      households: number | null;
      renters: number | null;
      lep: number | null;
      no_vehicle: number | null;
      poverty: string | null;
      affected: boolean;
    }>`
      with places as (
        select r.location_id as id from cg.report r
        where r.event_id = ${eventId}::uuid and r.withdrawn_at is null and r.location_id is not null
        union
        select n.location_id from cg.need n
        where n.event_id = ${eventId}::uuid and n.location_id is not null
      ),
      hit as (
        select distinct t.geoid from cg.ref_tract t
        join cg.location l on l.id in (select id from places) and l.geom is not null
          and st_intersects(t.geom, l.geom::geometry)
        where t.snapshot_id = ${tractSnap.id}::uuid
      )
      select t.geoid, t.name,
        st_y(st_pointonsurface(t.geom)) as lat, st_x(st_pointonsurface(t.geom)) as lon,
        p.households, p.renter_households as renters, p.limited_english_households as lep,
        p.no_vehicle_households as no_vehicle, p.poverty_pct as poverty,
        t.geoid in (select geoid from hit) as affected
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
  return {
    tracts: t.map((x) => {
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
        noVehiclePct: pct(x.no_vehicle),
        affected: x.affected,
      };
    }),
    profileAt: profileSnap?.retrieved_at ?? null,
    profiled: !!profileSnap,
  };
}

/** The ages every kind shows: the registry, flood zones and the Census profile (REC-10). */
function commonAges(
  candidates: Candidate[],
  flood: { at: Date | null; loaded: boolean },
  profile: { at: Date | null; loaded: boolean },
  now: Date,
  factors: PlanningFactors,
): InputAge[] {
  const oldest = candidates.reduce<Date | null>(
    (m, c) => (m === null || c.lastConfirmedAt < m ? c.lastConfirmedAt : m),
    null,
  );
  const staleEntries = candidates.filter(
    (c) => now.getTime() - c.lastConfirmedAt.getTime() > factors.staleDays * 86_400_000,
  ).length;
  return [
    inputAge(
      'Facility registry (oldest re-check)',
      oldest,
      now,
      factors.staleDays * 24,
      staleEntries
        ? `${staleEntries} entr${staleEntries === 1 ? 'y is' : 'ies are'} past the yearly re-check`
        : undefined,
    ),
    inputAge(
      'Flood zones (FEMA)',
      flood.at,
      now,
      24 * 400,
      flood.loaded ? undefined : 'not loaded: flood zones are not checked',
    ),
    inputAge(
      'Census tract profile',
      profile.at,
      now,
      24 * 800,
      profile.loaded ? undefined : 'not loaded: coverage cannot be checked',
    ),
  ];
}

const latest = async (q: Promise<{ rows: { at: Date | null }[] }>) => (await q).rows[0]?.at ?? null;

async function hazardAndOutageAges(trx: Trx, eventId: string, now: Date): Promise<InputAge[]> {
  const hazardAt = await latest(
    sql<{ at: Date | null }>`select max(reported_at) as at from cg.hazard
      where event_id = ${eventId}::uuid and kind in ('blocked_road', 'debris')`.execute(trx),
  );
  const outageAt = await latest(
    sql<{ at: Date | null }>`select max(greatest(started_at, updated_at)) as at from cg.outage
      where event_id = ${eventId}::uuid`.execute(trx),
  );
  return [
    inputAge(
      'Road blockages and debris reported',
      hazardAt,
      now,
      12,
      hazardAt ? undefined : 'none reported for this event',
    ),
    inputAge('Outages', outageAt, now, 12, outageAt ? undefined : 'none logged for this event'),
  ];
}

async function centroidOf(trx: Trx, locationIds: string[] | null, eventId: string) {
  const r = (
    await sql<{ lat: number | null; lon: number | null }>`
      select avg(st_y(l.geom::geometry)) as lat, avg(st_x(l.geom::geometry)) as lon
      from cg.location l
      where l.geom is not null and l.id in (${
        locationIds
          ? locationIds.length
            ? sql.join(locationIds.map((id) => sql`${id}::uuid`))
            : sql`null`
          : sql`select r.location_id from cg.report r
              where r.event_id = ${eventId}::uuid and r.withdrawn_at is null
            union select n.location_id from cg.need n where n.event_id = ${eventId}::uuid`
      })`.execute(trx)
  ).rows[0];
  return r && r.lat !== null && r.lon !== null
    ? ({ lat: Number(r.lat), lon: Number(r.lon) } satisfies Point)
    : null;
}

// ====================================================================== shelter

export async function loadShelterInputs(
  trx: Trx,
  tenantId: string,
  eventId: string,
  now = new Date(),
  factors: PlanningFactors = PLANNING_DEFAULTS,
): Promise<ShelterInputs> {
  const { candidates, floodLoadedAt, floodLoaded } = await loadCandidates(trx, tenantId, eventId);
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
        and n.status in ${OPEN}`.execute(trx)
  ).rows[0];
  const demand: Demand = {
    households: Number(d?.households ?? 0),
    petHouseholds: Number(d?.pets ?? 0),
    centroid:
      d && d.lat !== null && d.lon !== null ? { lat: Number(d.lat), lon: Number(d.lon) } : null,
  };
  const { tracts, profileAt, profiled } = await loadTracts(trx, tenantId, eventId);
  const [registry, flood, profile] = commonAges(
    candidates,
    { at: floodLoadedAt, loaded: floodLoaded },
    { at: profileAt, loaded: profiled },
    now,
    factors,
  );
  const [roads, outages] = await hazardAndOutageAges(trx, eventId, now);
  return {
    candidates,
    demand,
    tracts,
    inputs: [
      registry!,
      inputAge('Open needs from residents', now, now, 1, 'read live'),
      flood!,
      profile!,
      roads!,
      outages!,
    ],
  };
}

// ====================================================================== feeding (REC-05, REC-06)

export interface FeedingInputs {
  candidates: Candidate[];
  cells: DemandCell[];
  canteens: Canteen[];
  tracts: Tract[];
  inputs: InputAge[];
}

export async function loadFeedingInputs(
  trx: Trx,
  tenantId: string,
  eventId: string,
  now = new Date(),
  factors: PlanningFactors = PLANNING_DEFAULTS,
  teamIds?: string[],
): Promise<FeedingInputs> {
  const { candidates, floodLoadedAt, floodLoaded } = await loadCandidates(trx, tenantId, eventId);
  // Requests in cells of about a kilometre; positions are the average inside each cell.
  const cell = sql`round(st_y(l.geom::geometry)::numeric, 2), round(st_x(l.geom::geometry)::numeric, 2)`;
  const from = sql`from cg.need n
      left join cg.report r on r.id = n.report_id
      join cg.location l on l.id = coalesce(n.location_id, r.location_id) and l.geom is not null`;
  const where = sql`where n.tenant_id = ${tenantId}::uuid and n.event_id = ${eventId}::uuid
        and n.status in ${OPEN}`;
  const rows = (
    await sql<{
      gy: string;
      gx: string;
      lat: number;
      lon: number;
      food: string;
      pets: string;
      talk: string;
    }>`
      select ${cell},
        coalesce(avg(st_y(l.geom::geometry)) filter (where n.category = 'food_water'),
          avg(st_y(l.geom::geometry))) as lat,
        coalesce(avg(st_x(l.geom::geometry)) filter (where n.category = 'food_water'),
          avg(st_x(l.geom::geometry))) as lon,
        count(*) filter (where n.category = 'food_water') as food,
        count(*) filter (where n.category = 'pets') as pets,
        count(*) filter (where n.category = 'someone_to_talk') as talk
      ${from}
      ${where} and n.category in ('food_water', 'pets', 'someone_to_talk')
      group by 1, 2 order by 1, 2`.execute(trx)
  ).rows;
  const langs = (
    await sql<{ gy: string; gx: string; language: string; n: string }>`
      select ${cell}, cp.language, count(*) as n
      ${from}
      join cg.party cp on cp.id = coalesce(n.contact_party_id, r.reporter_party_id)
        and cp.language is not null
      ${where} and n.category = 'food_water'
      group by 1, 2, 3`.execute(trx)
  ).rows;
  const key = (gy: string, gx: string) => `${gy}|${gx}`;
  const byCell = new Map<string, Record<string, number>>();
  for (const l of langs) {
    const k = key(String(l.gy), String(l.gx));
    const m = byCell.get(k) ?? {};
    m[l.language] = Number(l.n);
    byCell.set(k, m);
  }
  const cells: DemandCell[] = rows.map((r) => ({
    position: { lat: Number(r.lat), lon: Number(r.lon) },
    food: Number(r.food),
    languages: byCell.get(key(String(r.gy), String(r.gx))) ?? {},
    pets: Number(r.pets),
    talk: Number(r.talk),
  }));
  const unplaced = Number(
    (
      await sql<{ n: string }>`select count(*) as n from cg.need n
        left join cg.report r on r.id = n.report_id
        left join cg.location l on l.id = coalesce(n.location_id, r.location_id)
        where n.tenant_id = ${tenantId}::uuid and n.event_id = ${eventId}::uuid
          and n.status in ${OPEN} and n.category = 'food_water' and l.geom is null`.execute(trx)
    ).rows[0]?.n ?? 0,
  );
  // REC-06: the canteens partners declared on the roster, with their limits.
  let q = trx
    .selectFrom('cg.team as t')
    .select((eb) => [
      't.id',
      't.name',
      't.agency',
      't.meals_per_hour',
      't.skills',
      't.updated_at',
      eb
        .selectFrom('cg.team_member as m')
        .select(eb.fn.countAll<string>().as('n'))
        .whereRef('m.team_id', '=', 't.id')
        .where('m.left_at', 'is', null)
        .as('staff'),
    ])
    .where('t.kind', '=', 'canteen')
    .where('t.status', '=', 'active')
    .where((eb) => eb.or([eb('t.event_id', 'is', null), eb('t.event_id', '=', eventId)]));
  if (teamIds?.length) q = q.where('t.id', 'in', teamIds);
  const teams = await q.orderBy('t.name').orderBy('t.id').execute();
  const canteens: Canteen[] = teams.map((t) => ({
    teamId: t.id,
    name: t.name,
    agency: t.agency,
    mealsPerHour: t.meals_per_hour,
    staff: Number(t.staff ?? 0),
    skills: t.skills,
  }));
  const { tracts, profileAt, profiled } = await loadTracts(trx, tenantId, eventId);
  const [registry, flood, profile] = commonAges(
    candidates,
    { at: floodLoadedAt, loaded: floodLoaded },
    { at: profileAt, loaded: profiled },
    now,
    factors,
  );
  const [roads] = await hazardAndOutageAges(trx, eventId, now);
  const rosterAt = teams.reduce<Date | null>(
    (m, t) => (m === null || t.updated_at > m ? t.updated_at : m),
    null,
  );
  return {
    candidates,
    cells,
    canteens,
    tracts,
    inputs: [
      inputAge(
        'Requests for food or water',
        now,
        now,
        1,
        unplaced
          ? `read live; ${unplaced} request${unplaced === 1 ? ' has' : 's have'} no location and cannot be placed`
          : 'read live',
      ),
      inputAge(
        'Canteens on the roster',
        rosterAt,
        now,
        24 * 7,
        teams.length ? undefined : 'none on the roster for this event',
      ),
      registry!,
      flood!,
      profile!,
      roads!,
    ],
  };
}

// ====================================================================== POD and walk-up points (REC-07, REC-08)

export interface PodInputs {
  candidates: Candidate[];
  demand: PodDemand;
  tracts: Tract[];
  inputs: InputAge[];
}

export async function loadPodInputs(
  trx: Trx,
  tenantId: string,
  eventId: string,
  now = new Date(),
  factors: PlanningFactors = PLANNING_DEFAULTS,
): Promise<PodInputs> {
  const { candidates, floodLoadedAt, floodLoaded } = await loadCandidates(trx, tenantId, eventId);
  const o = (
    await sql<{
      customers: string | null;
      uncounted: string;
      water: string;
      restoration: Date | null;
    }>`
      select coalesce(sum(customers_out) filter (where kind = 'power'), 0) as customers,
        count(*) filter (where kind = 'power' and customers_out is null) as uncounted,
        count(*) filter (where kind = 'water') as water,
        max(expected_restoration_at) filter (where kind = 'power') as restoration
      from cg.outage
      where tenant_id = ${tenantId}::uuid and event_id = ${eventId}::uuid and restored_at is null`.execute(
      trx,
    )
  ).rows[0];
  const demand: PodDemand = {
    powerCustomersOut: Number(o?.customers ?? 0),
    outagesUncounted: Number(o?.uncounted ?? 0),
    waterOutages: Number(o?.water ?? 0),
    restorationAt: o?.restoration ? new Date(o.restoration).toISOString() : null,
    centroid: await centroidOf(trx, null, eventId),
  };
  const { tracts, profileAt, profiled } = await loadTracts(trx, tenantId, eventId);
  const [registry, flood, profile] = commonAges(
    candidates,
    { at: floodLoadedAt, loaded: floodLoaded },
    { at: profileAt, loaded: profiled },
    now,
    factors,
  );
  const [roads, outages] = await hazardAndOutageAges(trx, eventId, now);
  return {
    candidates,
    demand,
    tracts,
    inputs: [outages!, registry!, flood!, profile!, roads!],
  };
}

// ====================================================================== MARC (REC-09)

export interface MarcInputs {
  candidates: Candidate[];
  demand: MarcDemand;
  tracts: Tract[];
  inputs: InputAge[];
}

export async function loadMarcInputs(
  trx: Trx,
  tenantId: string,
  eventId: string,
  now = new Date(),
  factors: PlanningFactors = PLANNING_DEFAULTS,
): Promise<MarcInputs> {
  const { candidates, floodLoadedAt, floodLoaded } = await loadCandidates(trx, tenantId, eventId);
  // Verified homes under the counting rule (DEC-02), the same figures the declaration uses.
  const records = await loadDamageRecords(trx, eventId);
  const totals = countDamage(records);
  const heavy = totals.counted.cells.filter(
    (c) => c.degree === 'major' || c.degree === 'destroyed',
  );
  const sum = (pick: (c: (typeof heavy)[number]) => boolean) =>
    heavy.filter(pick).reduce((s, c) => s + c.units, 0);
  const counted = new Set(totals.counted.recordIds);
  const heavyLocations = records
    .filter(
      (r) =>
        counted.has(r.id) &&
        (r.degree === 'major' || r.degree === 'destroyed') &&
        r.locationId !== null,
    )
    .map((r) => r.locationId!);
  const needs = Object.fromEntries(
    (
      await sql<{ category: string; n: string }>`
        select n.category, count(*) as n from cg.need n
        where n.tenant_id = ${tenantId}::uuid and n.event_id = ${eventId}::uuid
          and n.status in ${OPEN}
        group by 1`.execute(trx)
    ).rows.map((r) => [r.category, Number(r.n)]),
  );
  const languages = Object.fromEntries(
    (
      await sql<{ language: string; n: string }>`
        select coalesce(cp.language, r.original_lang) as language, count(*) as n
        from cg.report r
        left join cg.party cp on cp.id = r.reporter_party_id
        where r.tenant_id = ${tenantId}::uuid and r.event_id = ${eventId}::uuid
          and r.withdrawn_at is null and coalesce(cp.language, r.original_lang) is not null
        group by 1`.execute(trx)
    ).rows.map((r) => [r.language, Number(r.n)]),
  );
  const demand: MarcDemand = {
    majorDestroyed: sum(() => true),
    renters: sum((c) => c.tenure === 'renter'),
    owners: sum((c) => c.tenure === 'owner'),
    insured: sum((c) => c.insurance === 'insured'),
    uninsured: sum((c) => c.insurance === 'uninsured'),
    needs,
    languages,
    centroid: await centroidOf(trx, [...new Set(heavyLocations)], eventId),
  };
  const { tracts, profileAt, profiled } = await loadTracts(trx, tenantId, eventId);
  const [registry, flood, profile] = commonAges(
    candidates,
    { at: floodLoadedAt, loaded: floodLoaded },
    { at: profileAt, loaded: profiled },
    now,
    factors,
  );
  const [roads, outages] = await hazardAndOutageAges(trx, eventId, now);
  const reviewedAt = await latest(
    sql<{ at: Date | null }>`select max(fema_degree_set_at) as at from cg.report
      where event_id = ${eventId}::uuid`.execute(trx),
  );
  return {
    candidates,
    demand,
    tracts,
    inputs: [
      inputAge(
        'Verified damage (the counting rule)',
        reviewedAt,
        now,
        24,
        reviewedAt ? undefined : 'no damage degree set yet',
      ),
      inputAge('Open needs from residents', now, now, 1, 'read live'),
      registry!,
      flood!,
      profile!,
      roads!,
      outages!,
    ],
  };
}
