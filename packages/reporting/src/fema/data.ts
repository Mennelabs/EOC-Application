/**
 * What the FEMA package is filled from (layer-6 task F; DCL:DEC-11, DEC-12,
 * DEC-13, DEC-17, GATE-07): the declaration view's figures (the same code as
 * the console's Declaration screen), each home once with whether it is
 * counted or why it is shown apart, and the public damage sites. Every
 * value is keyed by the vocabulary's data elements. Nothing personal is
 * read: no names, contacts or street addresses; a home's place is its 100 m
 * grid cell, ZIP, tract and jurisdiction (DEC-13).
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { toUsng } from '@cg/field-core';
import { currentSnapshot } from '../area.ts';
import {
  classifyHomes,
  countDamage,
  type ClassifiedHome,
  type DamageRecord,
  type DamageTotals,
  type HomeStatus,
} from '../counting.ts';
import {
  declarationData,
  paSiteSelect,
  paSiteView,
  type DeclarationData,
  type PaSite,
} from '../declaration.ts';
import { shelterFigures } from '../facts.ts';
import { loadDamageRecords } from '../load.ts';
import type { ElementKey } from './vocabulary.ts';

type Trx = Transaction<Database>;
export type Value = string | number | null;

export const STATUS_LABEL: Record<HomeStatus, string> = {
  counted: 'Counted',
  selfReported: 'Self-reported, not verified',
  awaitingReview: 'Verified, awaiting review',
  inaccessible: 'Inaccessible',
  witness: 'Witness only',
  preExisting: 'Pre-existing damage',
  notPrimaryResidence: 'Not a primary residence',
  nonResidential: 'Not a home',
  noDamage: 'No damage',
  degreeNotSet: 'Degree not set',
};
const TYPE_LABEL: Record<string, string | null> = {
  single_family: 'Single family',
  multi_family: 'Multi-family',
  manufactured: 'Manufactured home',
  other: 'Other',
  unknown: null,
  non_residential: 'Business or other non-residential',
};
const DEGREE_LABEL: Record<string, string> = {
  affected: 'Affected',
  minor: 'Minor',
  major: 'Major',
  destroyed: 'Destroyed',
  no_damage: 'No damage',
};
const VERIFICATION_LABEL: Record<string, string> = {
  self_reported: 'Self-reported',
  desktop_verified: 'Verified at the desk',
  field_verified: 'Verified in the field',
  cannot_verify: 'Could not verify',
};
const TENURE_LABEL: Record<string, string | null> = {
  owner: 'Owner',
  renter: 'Renter',
  other: 'Other',
  unknown: null,
};
const INSURED_LABEL: Record<string, string | null> = {
  insured: 'Insured',
  uninsured: 'Uninsured',
  unknown: null,
};
const INSURANCE_TYPE_LABEL: Record<string, string> = {
  home_or_renters: 'Homeowners or renters',
  flood: 'Flood',
  condo: 'Condominium',
  manufactured_home: 'Manufactured home',
  sewer_backup: 'Sewer backup rider',
  other_rider: 'Other rider',
  none: 'None',
  not_sure: 'Not sure',
};
export const REASON_LABEL: Record<string, string> = {
  private_road_or_bridge: 'Private road or bridge',
  public_road_or_bridge: 'Public road or bridge',
  flood_water: 'Flood water',
  debris: 'Debris',
  hazard: 'Hazard',
  no_permission: 'No permission to enter',
  other: 'Other',
  'not given': 'Not given',
};
const UTILITY_LABEL: Record<string, string> = {
  electricity: 'electricity',
  water: 'water',
  gas: 'gas',
  phone_internet: 'phone or internet',
};

export interface HomeRow {
  status: HomeStatus;
  homeType: DamageRecord['homeType'];
  values: Partial<Record<ElementKey, Value>>;
  /** The 100 m cell's centre, for the GIS layer; null when the home has no position. */
  point: [number, number] | null;
}

export interface SiteRow {
  values: Partial<Record<ElementKey, Value>>;
  point: [number, number] | null;
}

export interface PackageData {
  event: { id: string; name: string; tenantName: string; timeZone: string };
  jurisdiction: { tenantId: string; name: string } | null;
  asOf: string;
  /** Event-wide figures: outages, casualties, shelters, the area profile, the indicators. */
  declaration: DeclarationData;
  /** The counting rule over the homes in scope (the whole event, or one jurisdiction). */
  damage: DamageTotals;
  homes: HomeRow[];
  sites: SiteRow[];
  shelters: { open: number; occupancy: number | null };
  jointPda: { dates: string | null; areas: string | null };
}

const feetInches = (inches: unknown): string | null => {
  if (typeof inches !== 'number' || !Number.isFinite(inches)) return null;
  return `${Math.floor(inches / 12)} ft ${inches % 12} in`;
};
const yesNo = (v: boolean | null | undefined) =>
  v === null || v === undefined ? null : v ? 'Yes' : 'No';
const answer = (a: unknown): unknown =>
  a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'value'
    ? (a as { value?: unknown }).value
    : undefined;
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
const dayIn = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
/** 100 m: three decimals of a degree is about 110 m north–south. */
const generalize = (lat: number, lon: number): [number, number] => [
  Math.round(lon * 1000) / 1000,
  Math.round(lat * 1000) / 1000,
];

export interface Detail {
  lat: number | null;
  lon: number | null;
  postal: string | null;
  jurisdiction: string | null;
  insurance: unknown;
  utilities: unknown;
  observations: Record<string, unknown> | null;
}

async function details(trx: Trx, records: DamageRecord[]): Promise<Map<string, Detail>> {
  const reports = records.filter((r) => r.kind === 'report').map((r) => r.id);
  const assessments = records.filter((r) => r.kind === 'assessment').map((r) => r.id);
  const out = new Map<string, Detail>();
  if (reports.length) {
    const rows = await sql<{
      id: string;
      lat: number | null;
      lon: number | null;
      postal: string | null;
      jurisdiction: string | null;
      insurance: unknown;
      utilities: unknown;
    }>`
      select r.id, ST_Y(l.geom) as lat, ST_X(l.geom) as lon, l.postal,
        j.name as jurisdiction,
        r.answers->'insurance' as insurance, r.answers->'utilities_out' as utilities
      from cg.report r
      left join cg.location l on l.id = r.location_id
      left join cg.location_geo g on g.location_id = r.location_id
      left join cg.tenant j on j.id = g.jurisdiction_tenant_id
      where r.id = any(${reports}::uuid[])`.execute(trx);
    for (const r of rows.rows)
      out.set(r.id, {
        lat: r.lat === null ? null : Number(r.lat),
        lon: r.lon === null ? null : Number(r.lon),
        postal: r.postal,
        jurisdiction: r.jurisdiction,
        insurance: answer(r.insurance),
        utilities: answer(r.utilities),
        observations: null,
      });
  }
  if (assessments.length) {
    const rows = await sql<{
      id: string;
      lat: number | null;
      lon: number | null;
      postal: string | null;
      jurisdiction: string | null;
      observations: Record<string, unknown> | null;
    }>`
      select a.id, ST_Y(coalesce(a.geom, l.geom)) as lat, ST_X(coalesce(a.geom, l.geom)) as lon,
        l.postal, j.name as jurisdiction,
        a.observations
      from cg.field_assessment a
      left join cg.location l on l.id = a.location_id
      left join cg.location_geo g on g.location_id = a.location_id
      left join cg.tenant j on j.id = g.jurisdiction_tenant_id
      where a.id = any(${assessments}::uuid[])`.execute(trx);
    for (const r of rows.rows) {
      const obs = r.observations ?? {};
      out.set(r.id, {
        lat: r.lat === null ? null : Number(r.lat),
        lon: r.lon === null ? null : Number(r.lon),
        postal: r.postal,
        jurisdiction: r.jurisdiction,
        insurance: obs['insurance'],
        utilities: obs['utilities_out'],
        observations: obs,
      });
    }
  }
  return out;
}

function utilitiesOut(v: unknown, fromField: boolean): string | null {
  if (fromField) return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : null;
  const out = list(v).filter((x) => x !== 'none');
  if (out.length) return `Yes: ${out.map((x) => UTILITY_LABEL[x] ?? x).join(', ')}`;
  return list(v).includes('none') ? 'No' : null;
}

/** One home as the vocabulary's values (pure: the details come from the database or a test). */
export function toHomeRow(
  { record: r, status }: ClassifiedHome,
  d: Detail | undefined,
  tractPovertyPct: number | null,
  timeZone: string,
): HomeRow {
  const obs = d?.observations ?? null;
  const point = d && d.lat !== null && d.lon !== null ? generalize(d.lat, d.lon) : null;
  const fromField = r.kind === 'assessment';
  const types = list(d?.insurance);
  return {
    status,
    homeType: r.homeType,
    point,
    values: {
      'record.ref': `${fromField ? 'A' : 'R'}-${r.id.slice(0, 8).toUpperCase()}`,
      'home.status': STATUS_LABEL[status],
      'location.usng': d && d.lat !== null && d.lon !== null ? toUsng(d.lat, d.lon, 3) : null,
      'location.lat': point ? point[1] : null,
      'location.lon': point ? point[0] : null,
      'location.postal': d?.postal ?? null,
      'location.tract': r.tractGeoid,
      'location.jurisdiction': d?.jurisdiction ?? null,
      'location.tract_poverty_pct': tractPovertyPct,
      'home.type': TYPE_LABEL[r.homeType] ?? null,
      'home.units': r.units,
      'home.occupancy': TENURE_LABEL[r.tenure] ?? null,
      'home.primary_residence': yesNo(r.primaryResidence),
      'home.degree': r.degree ? (DEGREE_LABEL[r.degree] ?? null) : null,
      'home.verification': VERIFICATION_LABEL[r.verification] ?? null,
      'home.inaccessible': status === 'inaccessible' ? 'Yes' : 'No',
      'home.inaccessible_reason':
        status === 'inaccessible'
          ? (REASON_LABEL[r.inaccessibleReason ?? 'not given'] ?? r.inaccessibleReason)
          : null,
      'home.insured': INSURED_LABEL[r.insurance] ?? null,
      'home.insurance_types': types.length
        ? types.map((t) => INSURANCE_TYPE_LABEL[t] ?? t).join('; ')
        : null,
      'home.utilities_out': utilitiesOut(d?.utilities, fromField),
      'home.water_depth_basement': feetInches(obs?.['flood_depth_basement_in']),
      'home.water_depth_first_floor': feetInches(obs?.['flood_depth_first_floor_in']),
      'home.water_depth_crawl_space': feetInches(obs?.['flood_depth_crawl_space_in']),
      'home.tribal_ownership':
        obs?.['tribal_ownership'] === 'tribe'
          ? 'Tribe'
          : obs?.['tribal_ownership'] === 'private'
            ? 'Private'
            : null,
      'home.pre_existing': yesNo(r.preExisting),
      'home.assessed_on': dayIn(r.at, timeZone),
      'home.source': fromField ? 'Field assessment' : 'Resident report',
      'home.photos': null,
      'business.employees':
        typeof obs?.['business_employees'] === 'number'
          ? (obs['business_employees'] as number)
          : null,
      'business.days_closed':
        typeof obs?.['business_days_closed'] === 'number'
          ? (obs['business_days_closed'] as number)
          : null,
    },
  };
}

/** Each home once, as the vocabulary's values. */
export async function homeRows(
  trx: Trx,
  tenantId: string,
  homes: ClassifiedHome[],
  timeZone: string,
): Promise<HomeRow[]> {
  const info = await details(
    trx,
    homes.map((h) => h.record),
  );
  // Low income is never asked per home: the tract's share below poverty stands in (NED-09).
  const profiles = await currentSnapshot(trx, tenantId, 'tract_profile');
  const poverty = new Map<string, number | null>();
  if (profiles) {
    const rows = await sql<{ geoid: string; poverty_pct: string | null }>`
      select geoid, poverty_pct from cg.ref_tract_profile where snapshot_id = ${profiles.id}`.execute(
      trx,
    );
    for (const r of rows.rows)
      poverty.set(r.geoid, r.poverty_pct === null ? null : Number(r.poverty_pct));
  }
  return homes.map((h) =>
    toHomeRow(
      h,
      info.get(h.record.id),
      h.record.tractGeoid ? (poverty.get(h.record.tractGeoid) ?? null) : null,
      timeZone,
    ),
  );
}

const SITE_YNU: Record<string, string | null> = { yes: 'Yes', no: 'No', unknown: null };

function siteRow(s: PaSite): SiteRow {
  const point = s.position ? generalize(s.position.lat, s.position.lon) : null;
  return {
    point,
    values: {
      'site.applicant': s.applicant,
      'site.name': s.name,
      'site.description': s.description,
      'site.category': s.category,
      'site.usng': s.position ? toUsng(s.position.lat, s.position.lon, 4) : null,
      'site.cost': s.estimatedCost,
      'site.cost_basis':
        s.estimatedCost === null ? null : s.costBasis === 'verified' ? 'Verified' : 'Estimate',
      'site.percent_complete': s.percentComplete,
      'site.insured': SITE_YNU[s.insured] ?? null,
      'site.other_federal_agency': SITE_YNU[s.otherFederalAgency] ?? null,
      'site.debris_cubic_yards': s.debrisCubicYards,
      'site.photos': s.photos,
    },
  };
}

/** Everything one package for an event (and, when named, one jurisdiction in it) is built from. */
export async function loadPackageData(
  trx: Trx,
  tenantId: string,
  eventId: string,
  opts: { jurisdictionTenantId?: string | null } = {},
): Promise<PackageData | null> {
  const event = await trx
    .selectFrom('cg.event as e')
    .innerJoin('cg.tenant as t', 't.id', 'e.tenant_id')
    .select(['e.id', 'e.name', 't.name as tenant_name', 't.timezone'])
    .where('e.id', '=', eventId)
    .executeTakeFirst();
  if (!event) return null;
  const declaration = await declarationData(trx, tenantId, eventId);
  if (!declaration) return null;
  const jurisdiction = opts.jurisdictionTenantId
    ? await trx
        .selectFrom('cg.tenant')
        .select(['id', 'name'])
        .where('id', '=', opts.jurisdictionTenantId)
        .executeTakeFirst()
    : undefined;
  // DEC-11: a package for one jurisdiction counts the homes located in it.
  let records = await loadDamageRecords(trx, eventId);
  if (jurisdiction) {
    const inside = new Set(
      (
        await trx
          .selectFrom('cg.location_geo')
          .select('location_id')
          .where('jurisdiction_tenant_id', '=', jurisdiction.id)
          .execute()
      ).map((x) => x.location_id),
    );
    records = records.filter((r) => r.locationId !== null && inside.has(r.locationId));
  }
  const sites = (
    await paSiteSelect(trx)
      .where('s.event_id', '=', eventId)
      .where('s.status', '=', 'active')
      .$if(!!jurisdiction, (q) => q.where('s.applicant_tenant_id', '=', jurisdiction!.id))
      .orderBy('s.category')
      .orderBy('s.name')
      .execute()
  ).map((r) => siteRow(paSiteView(r as Parameters<typeof paSiteView>[0])));
  return {
    event: {
      id: event.id,
      name: event.name,
      tenantName: event.tenant_name,
      timeZone: event.timezone,
    },
    jurisdiction: jurisdiction ? { tenantId: jurisdiction.id, name: jurisdiction.name } : null,
    asOf: declaration.asOf,
    declaration,
    damage: countDamage(records),
    homes: await homeRows(trx, tenantId, classifyHomes(records).homes, event.timezone),
    sites,
    shelters: await shelterFigures(trx, eventId),
    // Box 10 is filled from the joint assessment schedule (task F4).
    jointPda: { dates: null, areas: null },
  };
}
