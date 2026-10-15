/**
 * The declaration view's figures (layer-6 tasks D and F; DCL:DEC-05–DEC-11,
 * DEC-14, DEC-16, DEC-17, FL-17, RULE-02, GATE-07), computed in one place so
 * the console's Declaration screen and the FEMA package cannot disagree:
 * verified damage by the counting rule with what is shown apart, the area
 * profile, outages with the 72-hour flag, official casualty counts with
 * their sources, public damage by category against the per-capita
 * indicators, donated volunteer hours, what partner organizations committed
 * (DCL:DEC-09), and the 30-day filing clock. Runs
 * inside the caller's transaction (row-level security).
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { areaProfile, currentSnapshot, type AreaProfile } from './area.ts';
import { countDamage, type DamageTotals } from './counting.ts';
import { loadDamageRecords } from './load.ts';

type Trx = Transaction<Database>;

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : (d instanceof Date ? d : new Date(d)).toISOString();

export interface Outage {
  id: string;
  version: number;
  kind: (typeof OUTAGE_KINDS)[number];
  facilitySourceId: string | null;
  facilityName: string | null;
  description: string | null;
  area: string | null;
  customersOut: number | null;
  startedAt: string;
  expectedRestorationAt: string | null;
  restoredAt: string | null;
  source: 'staff' | 'feed_suggestion' | 'utility_report';
  confirmed: boolean;
  hoursOut: number;
  over72Hours: boolean;
}

export interface PaSite {
  id: string;
  version: number;
  applicant: string;
  name: string;
  description: string | null;
  category: (typeof CATEGORIES)[number];
  position: { lat: number; lon: number } | null;
  estimatedCost: number | null;
  costBasis: 'estimate' | 'verified';
  percentComplete: number | null;
  insured: 'yes' | 'no' | 'unknown';
  otherFederalAgency: 'yes' | 'no' | 'unknown';
  debrisCubicYards: number | null;
  status: 'active' | 'withdrawn';
  photos: number;
}

export interface Declaration {
  id: string;
  version: number;
  incidentType: string | null;
  incidentStart: string | null;
  incidentEnd: string | null;
  requestedAreas: { name: string; tenantId?: string; programs: string[] }[];
  box8Draft: string | null;
  box9Draft: string | null;
  reviewLabel: string;
  updatedAt: string;
}

export const OUTAGE_KINDS = [
  'hospital',
  'water',
  'wastewater',
  'police',
  'fire_ems',
  'school',
  'child_care',
  'eldercare',
  'roads',
  'power',
] as const;
export const CATEGORIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
const DAY = 86_400_000;
export const LONG_OUTAGE_HOURS = 72;

export type OutageRow = {
  id: string;
  version: number;
  kind: (typeof OUTAGE_KINDS)[number];
  facility_source_id: string | null;
  facility_name: string | null;
  description: string | null;
  area: string | null;
  customers_out: number | null;
  started_at: Date;
  expected_restoration_at: Date | null;
  restored_at: Date | null;
  source: 'staff' | 'feed_suggestion' | 'utility_report';
  confirmed_at: Date | null;
};

export function outageView(r: OutageRow, now = Date.now()): Outage {
  const end = r.restored_at ? new Date(r.restored_at).getTime() : now;
  const hours = Math.max(0, (end - new Date(r.started_at).getTime()) / 3_600_000);
  return {
    id: r.id,
    version: r.version,
    kind: r.kind,
    facilitySourceId: r.facility_source_id,
    facilityName: r.facility_name,
    description: r.description,
    area: r.area,
    customersOut: r.customers_out,
    startedAt: iso(r.started_at)!,
    expectedRestorationAt: iso(r.expected_restoration_at),
    restoredAt: iso(r.restored_at),
    source: r.source,
    confirmed: r.source === 'staff' || r.confirmed_at !== null,
    hoursOut: Math.round(hours * 10) / 10,
    over72Hours: hours > LONG_OUTAGE_HOURS,
  };
}

export type PaSiteRow = {
  id: string;
  version: number;
  applicant: string;
  name: string;
  description: string | null;
  category: (typeof CATEGORIES)[number];
  lat: number | null;
  lon: number | null;
  estimated_cost: string | null;
  cost_basis: 'estimate' | 'verified';
  percent_complete: number | null;
  insured: 'yes' | 'no' | 'unknown';
  other_federal_agency: 'yes' | 'no' | 'unknown';
  debris_cubic_yards: string | null;
  status: 'active' | 'withdrawn';
  photos: number | string;
};

export const paSiteView = (r: PaSiteRow): PaSite => ({
  id: r.id,
  version: r.version,
  applicant: r.applicant,
  name: r.name,
  description: r.description,
  category: r.category,
  position: r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
  estimatedCost: r.estimated_cost === null ? null : Number(r.estimated_cost),
  costBasis: r.cost_basis,
  percentComplete: r.percent_complete,
  insured: r.insured,
  otherFederalAgency: r.other_federal_agency,
  debrisCubicYards: r.debris_cubic_yards === null ? null : Number(r.debris_cubic_yards),
  status: r.status,
  photos: Number(r.photos),
});

export const paSiteSelect = (trx: Trx) =>
  trx
    .selectFrom('cg.pa_site as s')
    .select([
      's.id',
      's.version',
      's.applicant',
      's.name',
      's.description',
      's.category',
      sql<number | null>`ST_Y(s.geom)`.as('lat'),
      sql<number | null>`ST_X(s.geom)`.as('lon'),
      's.estimated_cost',
      's.cost_basis',
      's.percent_complete',
      's.insured',
      's.other_federal_agency',
      's.debris_cubic_yards',
      's.status',
      sql<string>`(select count(*) from cg.photo p where p.field_record_type = 'pa_site' and p.field_record_id = s.id)`.as(
        'photos',
      ),
    ]);

export const declarationView = (r: {
  id: string;
  version: number;
  incident_type: string | null;
  incident_start: string | Date | null;
  incident_end: string | Date | null;
  requested_areas: unknown;
  box8_draft: string | null;
  box9_draft: string | null;
  review_label: string;
  updated_at: Date;
}): Declaration => ({
  id: r.id,
  version: r.version,
  incidentType: r.incident_type,
  incidentStart: dayOf(r.incident_start),
  incidentEnd: dayOf(r.incident_end),
  requestedAreas: (r.requested_areas as Declaration['requestedAreas']) ?? [],
  box8Draft: r.box8_draft,
  box9Draft: r.box9_draft,
  reviewLabel: r.review_label,
  updatedAt: iso(r.updated_at)!,
});

export function dayOf(v: string | Date | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

/** DEC-16: a major disaster request is due within 30 days of the incident end date. */
export function filingClock(incidentEnd: string | null, now = new Date()) {
  if (!incidentEnd) return null;
  const end = Date.parse(`${incidentEnd}T00:00:00Z`);
  const deadline = new Date(end + 30 * DAY).toISOString().slice(0, 10);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const daysLeft = Math.round((Date.parse(`${deadline}T00:00:00Z`) - today) / DAY);
  return { incidentEnd, deadline, daysLeft, overdue: daysLeft < 0 };
}

export interface Indicators {
  statewidePerCapita: number | null;
  countywidePerCapita: number | null;
  statePopulation: number | null;
  fiscalYear: string | null;
}

export async function indicatorsOf(trx: Trx, tenantId: string): Promise<Indicators> {
  const row = await trx
    .selectFrom('cg.tenant_config')
    .select('value')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', 'declaration.pa_indicators')
    .executeTakeFirst();
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  return {
    statewidePerCapita: n(v['statewidePerCapita']),
    countywidePerCapita: n(v['countywidePerCapita']),
    statePopulation: n(v['statePopulation']),
    fiscalYear: typeof v['fiscalYear'] === 'string' ? v['fiscalYear'] : null,
  };
}

export type DeclarationData = NonNullable<Awaited<ReturnType<typeof declarationData>>>;

/** The figures of the declaration view for an event, or null when the event is not visible. */
export async function declarationData(trx: Trx, tenantId: string, eventId: string) {
  const event = await trx
    .selectFrom('cg.event')
    .select('id')
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) return null;
  const decl = await trx
    .selectFrom('cg.declaration')
    .selectAll()
    .where('event_id', '=', eventId)
    .executeTakeFirst();
  const damage = countDamage(await loadDamageRecords(trx, eventId));
  const profile = await areaProfile(trx, tenantId, eventId);
  const outages = (
    await trx
      .selectFrom('cg.outage')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('started_at')
      .execute()
  ).map((r) => outageView(r as OutageRow));
  const casualties = await sql<{
    kind: 'injured' | 'missing' | 'deceased';
    count: number;
    official_source: string;
    as_of: Date;
    entries: string;
  }>`
    select distinct on (kind) kind, count, official_source, as_of,
      count(*) over (partition by kind) as entries
    from cg.casualty_count where event_id = ${eventId}
    order by kind, as_of desc, created_at desc`.execute(trx);
  const sites = (
    await paSiteSelect(trx)
      .where('s.event_id', '=', eventId)
      .where('s.status', '=', 'active')
      .execute()
  ).map((r) => paSiteView(r as PaSiteRow));
  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => [
      c,
      {
        sites: sites.filter((x) => x.category === c).length,
        cost: sites.filter((x) => x.category === c).reduce((n, x) => n + (x.estimatedCost ?? 0), 0),
      },
    ]),
  );
  const totalCost = sites.reduce((n, x) => n + (x.estimatedCost ?? 0), 0);
  const indicators = await indicatorsOf(trx, tenantId);
  const profiles = await currentSnapshot(trx, tenantId, 'tract_profile');
  const county = profiles
    ? await sql<{ population: string | null; tracts: string; missing: string }>`
        select sum(population) as population, count(*) as tracts,
          count(*) filter (where population is null) as missing
        from cg.ref_tract_profile where snapshot_id = ${profiles.id}`.execute(trx)
    : null;
  const countyRow = county?.rows[0];
  const countyPopulation =
    countyRow && Number(countyRow.missing) === 0 && countyRow.population !== null
      ? Number(countyRow.population)
      : null;
  const threshold = (perCapita: number | null, population: number | null) =>
    perCapita !== null && population !== null
      ? Math.round(perCapita * population * 100) / 100
      : null;
  const countyThreshold = threshold(indicators.countywidePerCapita, countyPopulation);
  const stateThreshold = threshold(indicators.statewidePerCapita, indicators.statePopulation);
  // FL-17: hours from check-ins, by who donated them. Partner organizations' people and
  // registered walk-up volunteers donate; staff of the county itself do not.
  const hours = await sql<{
    agency: string | null;
    kind: string | null;
    donated: boolean;
    hours: string;
    people: string;
    open_shifts: string;
  }>`
    select t.name as agency, t.kind,
      (t.kind = 'partner_org' or exists (
        select 1 from cg.volunteer_registration v
        where v.personnel_id = c.personnel_id and v.event_id = c.event_id)) as donated,
      sum(coalesce(c.hours, extract(epoch from (now() - c.started_at)) / 3600)) as hours,
      count(distinct c.personnel_id) as people,
      count(*) filter (where c.ended_at is null) as open_shifts
    from cg.check_in c
    left join cg.tenant t on t.id = c.tenant_id
    where c.event_id = ${eventId}
    group by 1, 2, 3
    order by 3 desc, 1`.execute(trx);
  const donatedRows = hours.rows.filter((h) => h.donated);
  const round1 = (n: number) => Math.round(n * 10) / 10;

  // DCL:DEC-09: what partner organizations committed, from the needs they met, the
  // services logged for their teams, the shelters they ran and their teams checked
  // in. Counts only; nothing about a household. Only what the county can read:
  // a log a partner keeps under its own accounts stays with the partner (tenant
  // isolation) unless it shares it.
  const partnerRows = await sql<{
    id: string;
    name: string;
    what: 'need' | 'service' | 'shelter_households' | 'shelter_people' | 'team';
    k: string;
    n: string;
  }>`
    select t.id, t.name, 'need' as what, n.category as k, count(*) as n
      from cg.need n join cg.tenant t on t.id = n.claimed_by_tenant_id
      where n.event_id = ${eventId} and n.status in ('met', 'closed') and t.kind = 'partner_org'
      group by 1, 2, 4
    union all
    select t.id, t.name, 'service', s.kind, sum(s.count)
      from cg.service_log s join cg.team tm on tm.id = s.team_id
      join cg.tenant t on t.id = tm.agency_tenant_id
      where s.event_id = ${eventId} and t.kind = 'partner_org'
      group by 1, 2, 4
    union all
    select t.id, t.name, 'shelter_households', '', count(*)
      from cg.shelter_stay ss join cg.site st on st.id = ss.site_id
      join cg.tenant t on t.id = coalesce(st.operator_tenant_id, st.tenant_id)
      where ss.event_id = ${eventId} and t.kind = 'partner_org'
      group by 1, 2
    union all
    select t.id, t.name, 'shelter_people', '', sum(ss.household_size)
      from cg.shelter_stay ss join cg.site st on st.id = ss.site_id
      join cg.tenant t on t.id = coalesce(st.operator_tenant_id, st.tenant_id)
      where ss.event_id = ${eventId} and t.kind = 'partner_org'
      group by 1, 2
    union all
    select t.id, t.name, 'team', '', count(distinct c.team_id)
      from cg.check_in c join cg.team tm on tm.id = c.team_id
      join cg.tenant t on t.id = tm.agency_tenant_id
      where c.event_id = ${eventId} and t.kind = 'partner_org'
      group by 1, 2`.execute(trx);
  const orgs = new Map<
    string,
    {
      organization: string;
      needsMet: number;
      needsByCategory: Record<string, number>;
      services: Record<string, number>;
      shelteredHouseholds: number;
      shelteredPeople: number;
      teams: number;
    }
  >();
  for (const r of partnerRows.rows) {
    const o = orgs.get(r.id) ?? {
      organization: r.name,
      needsMet: 0,
      needsByCategory: {},
      services: {},
      shelteredHouseholds: 0,
      shelteredPeople: 0,
      teams: 0,
    };
    const n = Number(r.n);
    if (r.what === 'need') {
      o.needsMet += n;
      o.needsByCategory[r.k] = n;
    } else if (r.what === 'service') o.services[r.k] = n;
    else if (r.what === 'shelter_households') o.shelteredHouseholds = n;
    else if (r.what === 'shelter_people') o.shelteredPeople = n;
    else o.teams = n;
    orgs.set(r.id, o);
  }
  const partnerList = [...orgs.values()].sort((a, b) =>
    a.organization.localeCompare(b.organization),
  );
  const sumService = (k: string) => partnerList.reduce((n, o) => n + (o.services[k] ?? 0), 0);
  return {
    eventId,
    asOf: new Date().toISOString(),
    declaration: decl ? declarationView(decl) : null,
    clock: filingClock(decl ? dayOf(decl.incident_end) : null),
    damage: {
      counted: {
        units: damage.counted.units,
        homes: damage.counted.homes,
        unknownUnitBuildings: damage.counted.unknownUnitBuildings,
        byDegree: damage.counted.byDegree,
        cells: damage.counted.cells,
        byTract: damage.counted.byTract,
      },
      shownSeparately: damage.shownSeparately,
      merged: damage.merged,
      excluded: damage.excluded,
    },
    profile,
    outages: {
      items: outages,
      open: outages.filter((o) => !o.restoredAt).length,
      over72Hours: outages.filter((o) => o.over72Hours).length,
      unconfirmed: outages.filter((o) => !o.confirmed).length,
    },
    casualties: Object.fromEntries(
      (['injured', 'missing', 'deceased'] as const).map((k) => {
        const r = casualties.rows.find((x) => x.kind === k);
        return [
          k,
          r
            ? {
                count: r.count,
                officialSource: r.official_source,
                asOf: iso(r.as_of)!,
                entries: Number(r.entries),
              }
            : null,
        ];
      }),
    ),
    publicAssistance: {
      sites: sites.length,
      byCategory,
      totalCost: Math.round(totalCost * 100) / 100,
      verifiedCost:
        Math.round(
          sites
            .filter((x) => x.costBasis === 'verified')
            .reduce((n, x) => n + (x.estimatedCost ?? 0), 0) * 100,
        ) / 100,
      indicators: {
        ...indicators,
        countyPopulation,
        countyThreshold,
        stateThreshold,
        meetsCounty: countyThreshold === null ? null : totalCost >= countyThreshold,
        meetsState: stateThreshold === null ? null : totalCost >= stateThreshold,
      },
    },
    donated: {
      volunteerHours: round1(donatedRows.reduce((n, h) => n + Number(h.hours), 0)),
      includesOpenShifts: donatedRows.some((h) => Number(h.open_shifts) > 0),
      byOrganization: donatedRows.map((h) => ({
        organization:
          h.kind === 'partner_org' ? (h.agency ?? 'Partner organization') : 'Registered volunteers',
        hours: round1(Number(h.hours)),
        people: Number(h.people),
      })),
    },
    partners: {
      byOrganization: partnerList,
      totals: {
        needsMet: partnerList.reduce((n, o) => n + o.needsMet, 0),
        meals: sumService('meal'),
        waterCases: sumService('water_case'),
        tarps: sumService('tarp'),
        cots: sumService('cot'),
        rides: sumService('ride'),
        peopleServed: sumService('person_served'),
        shelteredHouseholds: partnerList.reduce((n, o) => n + o.shelteredHouseholds, 0),
        shelteredPeople: partnerList.reduce((n, o) => n + o.shelteredPeople, 0),
        teams: partnerList.reduce((n, o) => n + o.teams, 0),
      },
    },
  };
}

// Re-exported for callers that only need the damage part.
export type { AreaProfile, DamageTotals };
