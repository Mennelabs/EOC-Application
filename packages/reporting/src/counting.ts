/**
 * The counting rule (layer-6 plan §2; AC-14C, MET-06, GATE-07, DCL:DEC-03,
 * DEC-04, DEC-17, WIT-01, BRD:FR-12.05/12.06, RULE-02). One function decides
 * what counts toward degree-of-damage totals, so the console, the CSV, the
 * PDF and the FEMA package cannot disagree:
 *
 * - Records are resident reports and field assessments for one event.
 * - Withdrawn and rejected records leave; records marked duplicate or
 *   superseded, or linked to another as its duplicate, merge into it.
 * - One home, one count: records of the same home (the same parcel for a
 *   single-unit home, the same unit address for an apartment) count once,
 *   the best record winning (approved and verified first, field over desktop
 *   verification, then the latest). A field assessment of a whole apartment
 *   building counts its recorded units and absorbs unit reports there.
 * - Counted: the winner is approved (an accepted assessment counts as
 *   approved) and desktop- or field-verified, with a degree of affected,
 *   minor, major or destroyed, in a residence that is a primary residence
 *   without pre-existing damage.
 * - Shown separately, never added in: self-reported findings, verified
 *   findings still awaiting review, inaccessible homes with the reason,
 *   witness observations (WIT-01), pre-existing damage and non-primary
 *   residences (DEC-04), non-residential buildings, no damage, degree not
 *   set.
 * - Unknown is a category, never zero: tenure, insurance, home type and an
 *   apartment building's unit count can each be unknown and are reported so.
 *
 * Pure: the records come from `loadDamageRecords`, or from tests.
 */

export const DEGREES = ['affected', 'minor', 'major', 'destroyed'] as const;
export type Degree = (typeof DEGREES)[number];
export type Tenure = 'owner' | 'renter' | 'other' | 'unknown';
export type Insurance = 'insured' | 'uninsured' | 'unknown';
export type HomeType = 'single_family' | 'multi_family' | 'manufactured' | 'other' | 'unknown';
export type Verification =
  'self_reported' | 'desktop_verified' | 'field_verified' | 'cannot_verify';

export interface DamageRecord {
  kind: 'report' | 'assessment';
  id: string;
  /** Report review state; for an assessment: accepted → approved, new → under_review. */
  reviewState:
    | 'submitted'
    | 'under_review'
    | 'needs_information'
    | 'approved'
    | 'rejected'
    | 'duplicate'
    | 'superseded';
  verification: Verification;
  degree: Degree | 'no_damage' | 'cannot_tell' | null;
  relationship: 'own_home' | 'helper' | 'witness' | 'organization';
  primaryResidence: boolean | null;
  preExisting: boolean | null;
  withdrawn: boolean;
  /** Another record this one duplicates (BRD:FR-12.06). */
  duplicateOf: string | null;
  /** For an assessment: the report it was made for. */
  reportId: string | null;
  homeType: HomeType | 'non_residential';
  /** Units the record speaks for; null when a building's count is unknown. */
  units: number | null;
  /** True for a field assessment of a whole multi-unit building. */
  wholeBuilding: boolean;
  tenure: Tenure;
  insurance: Insurance;
  parcelId: string | null;
  /** Normalized address with the unit (line1|unit|postal). */
  addressKey: string | null;
  locationId: string | null;
  tractGeoid: string | null;
  inaccessibleReason: string | null;
  /** When the finding was made (submitted or assessed), ISO time. */
  at: string;
}

export interface CountedCell {
  degree: Degree;
  tenure: Tenure;
  insurance: Insurance;
  homeType: HomeType;
  verification: 'desktop_verified' | 'field_verified';
  units: number;
}

export interface DamageTotals {
  counted: {
    units: number;
    homes: number;
    /** Buildings counted as one unit because their unit count is unknown. */
    unknownUnitBuildings: number;
    byDegree: Record<Degree, number>;
    cells: CountedCell[];
    byTract: { tractGeoid: string | null; units: number; byDegree: Record<Degree, number> }[];
    /** The records counted, for drill-down and for citing record versions (RULE-10). */
    recordIds: string[];
  };
  shownSeparately: {
    selfReported: number;
    awaitingReview: number;
    inaccessible: { total: number; byReason: Record<string, number> };
    witness: number;
    preExisting: number;
    notPrimaryResidence: number;
    nonResidential: number;
    noDamage: number;
    degreeNotSet: number;
  };
  /** Records that leave the totals because another record of the same home stands for it. */
  merged: number;
  excluded: { withdrawn: number; rejected: number };
}

const zeroDegrees = (): Record<Degree, number> => ({
  affected: 0,
  minor: 0,
  major: 0,
  destroyed: 0,
});

const isVerified = (r: DamageRecord) =>
  r.verification === 'desktop_verified' || r.verification === 'field_verified';
const isCountable = (r: DamageRecord) => r.reviewState === 'approved' && isVerified(r);

/** Higher is better: who stands for a home when several records describe it. */
function rank(r: DamageRecord): number[] {
  return [
    r.relationship === 'witness' ? 0 : 1,
    isCountable(r) ? 1 : 0,
    r.verification === 'field_verified'
      ? 3
      : r.verification === 'desktop_verified'
        ? 2
        : r.verification === 'cannot_verify'
          ? 1
          : 0,
    r.kind === 'report' ? 1 : 0,
    Date.parse(r.at) || 0,
  ];
}

function better(a: DamageRecord, b: DamageRecord): DamageRecord {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]! ? a : b;
  return a.id < b.id ? a : b;
}

/** The home a record describes: the parcel for a single-unit home, the unit address for an apartment. */
export function homeKeyOf(r: DamageRecord): string {
  if (r.wholeBuilding && r.parcelId) return `building:${r.parcelId}`;
  if (r.homeType === 'multi_family')
    return r.addressKey
      ? `unit:${r.addressKey}`
      : r.locationId
        ? `location:${r.locationId}`
        : `record:${r.id}`;
  if (r.parcelId) return `parcel:${r.parcelId}`;
  if (r.addressKey) return `address:${r.addressKey}`;
  if (r.locationId) return `location:${r.locationId}`;
  return `record:${r.id}`;
}

export function countDamage(records: readonly DamageRecord[]): DamageTotals {
  const totals: DamageTotals = {
    counted: {
      units: 0,
      homes: 0,
      unknownUnitBuildings: 0,
      byDegree: zeroDegrees(),
      cells: [],
      byTract: [],
      recordIds: [],
    },
    shownSeparately: {
      selfReported: 0,
      awaitingReview: 0,
      inaccessible: { total: 0, byReason: {} },
      witness: 0,
      preExisting: 0,
      notPrimaryResidence: 0,
      nonResidential: 0,
      noDamage: 0,
      degreeNotSet: 0,
    },
    merged: 0,
    excluded: { withdrawn: 0, rejected: 0 },
  };

  // 1. Leave out withdrawn and rejected records; merge marked duplicates.
  const live: DamageRecord[] = [];
  for (const r of records) {
    if (r.withdrawn) totals.excluded.withdrawn++;
    else if (r.reviewState === 'rejected') totals.excluded.rejected++;
    else if (r.reviewState === 'duplicate' || r.reviewState === 'superseded' || r.duplicateOf)
      totals.merged++;
    else live.push(r);
  }

  // 2. An assessment made for a report describes that report's home.
  const byId = new Map(live.map((r) => [r.id, r]));
  const keyOf = (r: DamageRecord): string => {
    const linked = r.kind === 'assessment' && r.reportId ? byId.get(r.reportId) : undefined;
    return linked && !r.wholeBuilding ? homeKeyOf(linked) : homeKeyOf(r);
  };

  // 3. One home, one count.
  const homes = new Map<string, DamageRecord>();
  for (const r of live) {
    const key = keyOf(r);
    const held = homes.get(key);
    if (held) totals.merged++;
    homes.set(key, held ? better(held, r) : r);
  }

  // 4. A counted whole-building assessment absorbs the unit reports on its parcel.
  const buildings = new Set(
    [...homes.values()]
      .filter((r) => r.wholeBuilding && r.parcelId && isCountable(r))
      .map((r) => r.parcelId!),
  );
  const tracts = new Map<string | null, { units: number; byDegree: Record<Degree, number> }>();
  const cells = new Map<string, CountedCell>();
  const s = totals.shownSeparately;

  for (const r of homes.values()) {
    if (
      !r.wholeBuilding &&
      r.homeType === 'multi_family' &&
      r.parcelId &&
      buildings.has(r.parcelId)
    ) {
      totals.merged++;
      continue;
    }
    if (r.relationship === 'witness') {
      s.witness++;
      continue;
    }
    if (r.verification === 'cannot_verify') {
      s.inaccessible.total++;
      const reason = r.inaccessibleReason ?? 'not given';
      s.inaccessible.byReason[reason] = (s.inaccessible.byReason[reason] ?? 0) + 1;
      continue;
    }
    if (!isVerified(r)) {
      s.selfReported++;
      continue;
    }
    if (r.reviewState !== 'approved') {
      s.awaitingReview++;
      continue;
    }
    if (r.homeType === 'non_residential') {
      s.nonResidential++;
      continue;
    }
    if (r.preExisting === true) {
      s.preExisting++;
      continue;
    }
    if (r.primaryResidence === false) {
      s.notPrimaryResidence++;
      continue;
    }
    if (r.degree === 'no_damage') {
      s.noDamage++;
      continue;
    }
    if (r.degree === null || r.degree === 'cannot_tell') {
      s.degreeNotSet++;
      continue;
    }
    const units = r.units ?? 1;
    if (r.units === null) totals.counted.unknownUnitBuildings++;
    totals.counted.units += units;
    totals.counted.homes++;
    totals.counted.byDegree[r.degree] += units;
    totals.counted.recordIds.push(r.id);
    const tract = tracts.get(r.tractGeoid) ?? { units: 0, byDegree: zeroDegrees() };
    tract.units += units;
    tract.byDegree[r.degree] += units;
    tracts.set(r.tractGeoid, tract);
    const cell: CountedCell = {
      degree: r.degree,
      tenure: r.tenure,
      insurance: r.insurance,
      homeType: r.homeType,
      verification: r.verification as CountedCell['verification'],
      units: 0,
    };
    const key = `${cell.degree}|${cell.tenure}|${cell.insurance}|${cell.homeType}|${cell.verification}`;
    const held = cells.get(key) ?? cell;
    held.units += units;
    cells.set(key, held);
  }

  // A fixed order (not the locale's), so every output lists the cells the same way.
  const order = (c: CountedCell) =>
    `${DEGREES.indexOf(c.degree)}|${c.tenure}|${c.insurance}|${c.homeType}|${c.verification}`;
  totals.counted.cells = [...cells.values()].sort((a, b) =>
    order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
  );
  totals.counted.byTract = [...tracts.entries()]
    .map(([tractGeoid, t]) => ({ tractGeoid, ...t }))
    // Tract order, the row without a tract last.
    .sort((a, b) =>
      a.tractGeoid === b.tractGeoid
        ? 0
        : a.tractGeoid === null
          ? 1
          : b.tractGeoid === null
            ? -1
            : a.tractGeoid < b.tractGeoid
              ? -1
              : 1,
    );
  totals.counted.recordIds.sort();
  return totals;
}
