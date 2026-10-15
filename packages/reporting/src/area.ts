/**
 * An event area's population profile and the reference snapshots to cite
 * (layer 6; DCL:DEC-06, EQ-11, RULE-02, RULE-10, NED-09). One function for
 * `/refdata/profile`, the declaration view and the FEMA package, so all say
 * the same thing: the tracts the event's footprint touches, or else the
 * tracts where its reports are; shares weighted by population or
 * households; a tract without an estimate named, never counted as zero; low
 * income a tract figure only.
 */
import { sql, type Transaction } from 'kysely';
import type { Database, ReferenceDataset } from '@cg/db';

type Trx = Transaction<Database>;

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : (d instanceof Date ? d : new Date(d)).toISOString();

export interface ProfileRow {
  geoid: string;
  population: number | null;
  households: number | null;
  renterHouseholds: number | null;
  medianHouseholdIncome: number | null;
  povertyPct: number | null;
  snapHouseholdsPct: number | null;
  ssiHouseholdsPct: number | null;
  age65Pct: number | null;
  disabilityPct: number | null;
  limitedEnglishHouseholds: number | null;
  noVehicleHouseholds: number | null;
  languages: Record<string, number>;
  moe: Record<string, number>;
}

export type Citation = { snapshotId: string; vintage: string | null; retrievedAt: string } | null;

export interface AreaProfile {
  eventId: string;
  basis: 'footprint' | 'reports' | 'none';
  tracts: Citation;
  profiles: Citation;
  items: ProfileRow[];
  missing: string[];
  total: {
    tracts: number;
    population: number | null;
    households: number | null;
    renterHouseholds: number | null;
    povertyPct: number | null;
    snapHouseholdsPct: number | null;
    ssiHouseholdsPct: number | null;
    age65Pct: number | null;
    disabilityPct: number | null;
    limitedEnglishHouseholds: number | null;
    noVehicleHouseholds: number | null;
  };
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export const profileOf = (r: Record<string, unknown>): ProfileRow => ({
  geoid: String(r['geoid']),
  population: num(r['population']),
  households: num(r['households']),
  renterHouseholds: num(r['renter_households']),
  medianHouseholdIncome: num(r['median_household_income']),
  povertyPct: num(r['poverty_pct']),
  snapHouseholdsPct: num(r['snap_households_pct']),
  ssiHouseholdsPct: num(r['ssi_households_pct']),
  age65Pct: num(r['age65_pct']),
  disabilityPct: num(r['disability_pct']),
  limitedEnglishHouseholds: num(r['limited_english_households']),
  noVehicleHouseholds: num(r['no_vehicle_households']),
  languages: (r['languages'] as Record<string, number>) ?? {},
  moe: (r['moe'] as Record<string, number>) ?? {},
});

/** The tenant's current snapshot of a dataset, for citing (RULE-10). */
export function currentSnapshot(trx: Trx, tenantId: string, dataset: ReferenceDataset) {
  return trx
    .selectFrom('cg.refdata_current as c')
    .innerJoin('cg.refdata_snapshot as s', 's.id', 'c.snapshot_id')
    .select(['s.id', 's.vintage', 's.retrieved_at'])
    .where('c.tenant_id', '=', tenantId)
    .where('c.dataset', '=', dataset)
    .executeTakeFirst();
}

export const cite = (s: { id: string; vintage: string | null; retrieved_at: Date } | undefined) =>
  s ? { snapshotId: s.id, vintage: s.vintage, retrievedAt: iso(s.retrieved_at)! } : null;

/** The event area's profile, or null when the event is not visible to the caller. */
export async function areaProfile(
  trx: Trx,
  tenantId: string,
  eventId: string,
): Promise<AreaProfile | null> {
  const event = await trx
    .selectFrom('cg.event')
    .select(['id', sql<boolean>`footprint is not null`.as('has_footprint')])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) return null;
  const tracts = await currentSnapshot(trx, tenantId, 'tract');
  const profiles = await currentSnapshot(trx, tenantId, 'tract_profile');
  let basis: AreaProfile['basis'] = 'none';
  let geoids: string[] = [];
  if (tracts && event.has_footprint) {
    basis = 'footprint';
    geoids = (
      await sql<{ geoid: string }>`
        select t.geoid from cg.ref_tract t, cg.event e
        where t.snapshot_id = ${tracts.id} and e.id = ${eventId}
          and st_intersects(t.geom, e.footprint)
        order by t.geoid`.execute(trx)
    ).rows.map((r) => r.geoid);
  } else if (tracts) {
    geoids = (
      await sql<{ geoid: string }>`
        select distinct g.tract_geoid as geoid from cg.report r
        join cg.location_geo g on g.location_id = r.location_id
        where r.event_id = ${eventId} and r.withdrawn_at is null
          and g.tract_snapshot_id = ${tracts.id} and g.tract_geoid is not null
        order by 1`.execute(trx)
    ).rows.map((r) => r.geoid);
    if (geoids.length) basis = 'reports';
  }
  const rows =
    profiles && geoids.length
      ? (
          await sql<Record<string, unknown>>`
            select * from cg.ref_tract_profile
            where snapshot_id = ${profiles.id} and geoid = any(${geoids})
            order by geoid`.execute(trx)
        ).rows.map(profileOf)
      : [];
  const found = new Set(rows.map((r) => r.geoid));
  const sum = (pick: (r: ProfileRow) => number | null) =>
    rows.length && rows.every((r) => pick(r) !== null)
      ? rows.reduce((n, r) => n + (pick(r) ?? 0), 0)
      : null;
  /** A share across tracts, weighted by population or households; unknown if any part is. */
  const weighted = (
    pct: (r: ProfileRow) => number | null,
    weight: (r: ProfileRow) => number | null,
  ) => {
    if (!rows.length || rows.some((r) => pct(r) === null || weight(r) === null)) return null;
    const w = rows.reduce((n, r) => n + (weight(r) ?? 0), 0);
    return w === 0
      ? null
      : Math.round((rows.reduce((n, r) => n + (pct(r) ?? 0) * (weight(r) ?? 0), 0) / w) * 10) / 10;
  };
  const people = (r: ProfileRow) => r.population;
  const homes = (r: ProfileRow) => r.households;
  return {
    eventId,
    basis,
    tracts: cite(tracts),
    profiles: cite(profiles),
    items: rows,
    missing: geoids.filter((g) => !found.has(g)),
    total: {
      tracts: geoids.length,
      population: sum(people),
      households: sum(homes),
      renterHouseholds: sum((r) => r.renterHouseholds),
      povertyPct: weighted((r) => r.povertyPct, people),
      snapHouseholdsPct: weighted((r) => r.snapHouseholdsPct, homes),
      ssiHouseholdsPct: weighted((r) => r.ssiHouseholdsPct, homes),
      age65Pct: weighted((r) => r.age65Pct, people),
      disabilityPct: weighted((r) => r.disabilityPct, people),
      limitedEnglishHouseholds: sum((r) => r.limitedEnglishHouseholds),
      noVehicleHouseholds: sum((r) => r.noVehicleHouseholds),
    },
  };
}
