/**
 * Reads one event's damage records for the counting rule (layer-6 plan §2):
 * resident reports with their location, tract and the answers the count
 * needs (home type, units, tenure, insurance, access), and field
 * assessments. Only clear (non-restricted) answers are read; nothing
 * personal leaves this function. Runs inside the caller's transaction, so
 * row-level security limits it to the caller's tenant (SEC-05).
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { cantReachReasonOf } from '@cg/field-core';
import type { DamageRecord, HomeType, Insurance, Tenure } from './counting.ts';

type Answer = { kind?: string; value?: unknown } | null;

const value = (a: Answer): unknown => (a && a.kind === 'value' ? a.value : undefined);

export function homeTypeFromAnswer(a: Answer): HomeType | 'non_residential' {
  switch (value(a)) {
    case 'house':
      return 'single_family';
    case 'apartment_condo':
      return 'multi_family';
    case 'mobile_manufactured':
      return 'manufactured';
    case 'business':
      return 'non_residential';
    case 'other':
      return 'other';
    default:
      return 'unknown';
  }
}

export function tenureFromAnswer(a: Answer): Tenure {
  const v = value(a);
  return v === 'own' ? 'owner' : v === 'rent' ? 'renter' : v === 'other' ? 'other' : 'unknown';
}

/** Any named coverage is insured; "no insurance" alone is uninsured; "not sure" or nothing is unknown. */
export function insuranceFromAnswer(a: Answer): Insurance {
  const v = value(a);
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
  const named = list.filter((x) => x !== 'none' && x !== 'not_sure');
  if (named.length) return 'insured';
  if (list.includes('none') && !list.includes('not_sure')) return 'uninsured';
  return 'unknown';
}

const STRUCTURE: Record<string, HomeType | 'non_residential'> = {
  single_family: 'single_family',
  manufactured: 'manufactured',
  apartment_building: 'multi_family',
  commercial: 'non_residential',
  public: 'non_residential',
  other: 'other',
};

export async function loadDamageRecords(
  trx: Transaction<Database>,
  eventId: string,
  opts: { cutoff?: Date } = {},
): Promise<DamageRecord[]> {
  // A report or assessment made after the cutoff is not in figures as of the cutoff.
  const cutoff = opts.cutoff ?? null;
  const reports = await sql<{
    id: string;
    version: number;
    review_state: DamageRecord['reviewState'];
    verification_level: DamageRecord['verification'];
    fema_degree: DamageRecord['degree'];
    relationship: DamageRecord['relationship'];
    is_primary_residence: boolean | null;
    pre_existing_damage: boolean | null;
    withdrawn: boolean;
    duplicate_of: string | null;
    home_type: Answer;
    units: Answer;
    occupancy: Answer;
    insurance: Answer;
    access: Answer;
    parcel_id: string | null;
    address_key: string | null;
    location_id: string | null;
    tract_geoid: string | null;
    submitted_at: Date;
  }>`
    select r.id, r.version, r.review_state, r.verification_level, r.fema_degree, r.relationship,
      r.is_primary_residence, r.pre_existing_damage, r.withdrawn_at is not null as withdrawn,
      r.duplicate_of, r.answers->'home_type' as home_type, r.answers->'units' as units,
      r.answers->'occupancy' as occupancy, r.answers->'insurance' as insurance,
      r.answers->'access' as access, l.parcel_id, l.address_key, r.location_id,
      g.tract_geoid, r.submitted_at
    from cg.report r
    left join cg.location l on l.id = r.location_id
    left join cg.location_geo g on g.location_id = r.location_id
    where r.event_id = ${eventId}
      and (${cutoff}::timestamptz is null or r.submitted_at <= ${cutoff}::timestamptz)`.execute(
    trx,
  );

  const assessments = await sql<{
    id: string;
    version: number;
    review_state: 'new' | 'accepted' | 'rejected' | 'superseded';
    degree: DamageRecord['degree'] | 'cant_reach';
    structure: string;
    observations: Record<string, unknown>;
    parcel_id: string | null;
    location_id: string | null;
    report_id: string | null;
    duplicate_of: string | null;
    address_key: string | null;
    tract_geoid: string | null;
    assessed_at: Date;
  }>`
    select a.id, a.version, a.review_state, a.degree, a.structure, a.observations, a.parcel_id,
      a.location_id, a.report_id, a.duplicate_of, l.address_key, g.tract_geoid, a.assessed_at
    from cg.field_assessment a
    left join cg.location l on l.id = a.location_id
    left join cg.location_geo g on g.location_id = a.location_id
    where a.event_id = ${eventId}
      and (${cutoff}::timestamptz is null or a.assessed_at <= ${cutoff}::timestamptz)`.execute(trx);

  const out: DamageRecord[] = reports.rows.map((r) => {
    const homeType = homeTypeFromAnswer(r.home_type);
    const units = value(r.units);
    return {
      kind: 'report',
      id: r.id,
      version: r.version,
      reviewState: r.review_state,
      verification: r.verification_level,
      degree: r.fema_degree,
      relationship: r.relationship,
      primaryResidence: r.is_primary_residence,
      preExisting: r.pre_existing_damage,
      withdrawn: r.withdrawn,
      duplicateOf: r.duplicate_of,
      reportId: null,
      homeType,
      // A resident's report is one home; an organization may report a building's units.
      units:
        r.relationship === 'organization' && homeType === 'multi_family'
          ? typeof units === 'number' && units > 0
            ? units
            : null
          : 1,
      wholeBuilding: r.relationship === 'organization' && homeType === 'multi_family',
      tenure: tenureFromAnswer(r.occupancy),
      insurance: insuranceFromAnswer(r.insurance),
      parcelId: r.parcel_id,
      addressKey: r.address_key,
      locationId: r.location_id,
      tractGeoid: r.tract_geoid,
      // DCL:DEC-17: FEMA asks whether a private or a public road or bridge blocked the home.
      inaccessibleReason:
        r.verification_level === 'cannot_verify'
          ? (cantReachReasonOf(value(r.access)) ?? 'not given')
          : null,
      at: new Date(r.submitted_at).toISOString(),
    };
  });

  for (const a of assessments.rows) {
    const homeType = STRUCTURE[a.structure] ?? 'other';
    const building = a.structure === 'apartment_building';
    const units = a.observations?.['units'];
    const reason = cantReachReasonOf(a.observations?.['cant_reach_reason']);
    out.push({
      kind: 'assessment',
      id: a.id,
      version: a.version,
      reviewState:
        a.review_state === 'accepted'
          ? 'approved'
          : a.review_state === 'new'
            ? 'under_review'
            : a.review_state === 'rejected'
              ? 'rejected'
              : 'superseded',
      verification: a.degree === 'cant_reach' ? 'cannot_verify' : 'field_verified',
      degree: a.degree === 'cant_reach' ? null : a.degree,
      relationship: 'organization',
      primaryResidence: null,
      preExisting: null,
      withdrawn: false,
      duplicateOf: a.duplicate_of,
      reportId: a.report_id,
      homeType,
      units: building ? (typeof units === 'number' && units > 0 ? units : null) : 1,
      wholeBuilding: building,
      tenure: tenureFromAnswer({ kind: 'value', value: a.observations?.['occupancy'] }),
      insurance: insuranceFromAnswer({ kind: 'value', value: a.observations?.['insurance'] }),
      parcelId: a.parcel_id,
      addressKey: a.address_key,
      locationId: a.location_id,
      tractGeoid: a.tract_geoid,
      inaccessibleReason: a.degree === 'cant_reach' ? (reason ?? 'not given') : null,
      at: new Date(a.assessed_at).toISOString(),
    });
  }
  return out;
}
