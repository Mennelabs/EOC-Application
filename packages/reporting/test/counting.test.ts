/**
 * The counting rule, case by case (layer-6 plan §2; DCL:DEC-03, DEC-04,
 * WIT-01, BRD:FR-12.06, RULE-02, AC-14C). Each test names the rule it pins.
 */
import { describe, expect, it } from 'vitest';
import {
  countDamage,
  homeKeyOf,
  homeTypeFromAnswer,
  insuranceFromAnswer,
  tenureFromAnswer,
  type DamageRecord,
} from '../src/index.ts';

let n = 0;
function rec(over: Partial<DamageRecord> = {}): DamageRecord {
  n++;
  return {
    kind: 'report',
    id: `r${String(n).padStart(4, '0')}`,
    version: 1,
    reviewState: 'approved',
    verification: 'desktop_verified',
    degree: 'major',
    relationship: 'own_home',
    primaryResidence: true,
    preExisting: false,
    withdrawn: false,
    duplicateOf: null,
    reportId: null,
    homeType: 'single_family',
    units: 1,
    wholeBuilding: false,
    tenure: 'owner',
    insurance: 'insured',
    parcelId: `P-${n}`,
    addressKey: `${n} main st||63001`,
    locationId: `loc-${n}`,
    tractGeoid: '29999000100',
    inaccessibleReason: null,
    at: `2026-10-14T12:${String(n % 60).padStart(2, '0')}:00.000Z`,
    ...over,
  };
}

describe('what counts (DCL:DEC-03)', () => {
  it('counts approved records verified at the desk or in the field, by degree', () => {
    const t = countDamage([
      rec({ degree: 'affected' }),
      rec({ degree: 'minor', verification: 'field_verified' }),
      rec({ degree: 'major' }),
      rec({ degree: 'destroyed', kind: 'assessment', verification: 'field_verified' }),
    ]);
    expect(t.counted.byDegree).toEqual({ affected: 1, minor: 1, major: 1, destroyed: 1 });
    expect(t.counted.units).toBe(4);
    expect(t.counted.homes).toBe(4);
  });

  it('shows self-reported findings and verified findings awaiting review apart, never adds them in', () => {
    const t = countDamage([
      rec({ verification: 'self_reported', reviewState: 'submitted' }),
      rec({ verification: 'self_reported', reviewState: 'approved' }),
      rec({ verification: 'desktop_verified', reviewState: 'under_review' }),
      rec(),
    ]);
    expect(t.counted.units).toBe(1);
    expect(t.shownSeparately.selfReported).toBe(2);
    expect(t.shownSeparately.awaitingReview).toBe(1);
  });

  it('shows inaccessible homes with their reason (DEC-17)', () => {
    const t = countDamage([
      rec({ verification: 'cannot_verify', inaccessibleReason: 'road_closed' }),
      rec({ verification: 'cannot_verify', inaccessibleReason: 'road_closed' }),
      rec({ verification: 'cannot_verify', inaccessibleReason: null }),
    ]);
    expect(t.counted.units).toBe(0);
    expect(t.shownSeparately.inaccessible).toEqual({
      total: 3,
      byReason: { road_closed: 2, 'not given': 1 },
    });
  });

  it('keeps witness observations apart (WIT-01) but counts a verified helper report', () => {
    const t = countDamage([rec({ relationship: 'witness' }), rec({ relationship: 'helper' })]);
    expect(t.shownSeparately.witness).toBe(1);
    expect(t.counted.units).toBe(1);
  });

  it('keeps pre-existing damage and non-primary residences out of the totals (DEC-04)', () => {
    const t = countDamage([
      rec({ preExisting: true }),
      rec({ primaryResidence: false }),
      rec({ primaryResidence: null }),
    ]);
    expect(t.shownSeparately.preExisting).toBe(1);
    expect(t.shownSeparately.notPrimaryResidence).toBe(1);
    // Unknown residence status is not proof it is not a home: counted, with its unknowns reported.
    expect(t.counted.units).toBe(1);
  });

  it('keeps non-residential buildings, no damage and an unset degree apart', () => {
    const t = countDamage([
      rec({ homeType: 'non_residential' }),
      rec({ degree: 'no_damage' }),
      rec({ degree: 'cannot_tell' }),
      rec({ degree: null }),
    ]);
    expect(t.counted.units).toBe(0);
    expect(t.shownSeparately).toMatchObject({ nonResidential: 1, noDamage: 1, degreeNotSet: 2 });
  });

  it('leaves out withdrawn and rejected records', () => {
    const t = countDamage([rec({ withdrawn: true }), rec({ reviewState: 'rejected' }), rec()]);
    expect(t.excluded).toEqual({ withdrawn: 1, rejected: 1 });
    expect(t.counted.units).toBe(1);
  });
});

describe('one home, one count (BRD:FR-12.06)', () => {
  it('merges records marked duplicate or superseded, or linked as duplicates', () => {
    const a = rec();
    const t = countDamage([
      a,
      rec({ reviewState: 'duplicate' }),
      rec({ reviewState: 'superseded' }),
      rec({ duplicateOf: a.id }),
    ]);
    expect(t.counted.units).toBe(1);
    expect(t.merged).toBe(3);
  });

  it('counts two reports of the same house once, the verified one winning', () => {
    const t = countDamage([
      rec({
        parcelId: 'P-1',
        verification: 'self_reported',
        reviewState: 'submitted',
        degree: 'destroyed',
      }),
      rec({ parcelId: 'P-1', verification: 'field_verified', degree: 'minor' }),
    ]);
    expect(t.counted.byDegree).toMatchObject({ minor: 1, destroyed: 0 });
    expect(t.merged).toBe(1);
    expect(t.shownSeparately.selfReported).toBe(0);
  });

  it('prefers field verification to desk verification, then the latest finding', () => {
    const t = countDamage([
      rec({ parcelId: 'P-2', degree: 'major', at: '2026-10-14T13:00:00Z' }),
      rec({
        parcelId: 'P-2',
        degree: 'minor',
        verification: 'field_verified',
        at: '2026-10-14T12:00:00Z',
      }),
      rec({ parcelId: 'P-3', degree: 'affected', at: '2026-10-14T12:00:00Z' }),
      rec({ parcelId: 'P-3', degree: 'destroyed', at: '2026-10-14T14:00:00Z' }),
    ]);
    expect(t.counted.byDegree).toEqual({ affected: 0, minor: 1, major: 0, destroyed: 1 });
  });

  it('counts apartments in one building per unit, by unit address', () => {
    const t = countDamage([
      rec({ homeType: 'multi_family', parcelId: 'B-1', addressKey: '10 elm||apt 1|63002' }),
      rec({ homeType: 'multi_family', parcelId: 'B-1', addressKey: '10 elm||apt 2|63002' }),
      rec({ homeType: 'multi_family', parcelId: 'B-1', addressKey: '10 elm||apt 2|63002' }),
    ]);
    expect(t.counted.units).toBe(2);
    expect(t.merged).toBe(1);
  });

  it('counts a field assessment of a whole building by its units, absorbing the unit reports there', () => {
    const t = countDamage([
      rec({
        kind: 'assessment',
        verification: 'field_verified',
        homeType: 'multi_family',
        wholeBuilding: true,
        units: 24,
        parcelId: 'B-2',
        tenure: 'unknown',
        insurance: 'unknown',
      }),
      rec({ homeType: 'multi_family', parcelId: 'B-2', addressKey: '20 oak||apt 3|63002' }),
    ]);
    expect(t.counted.units).toBe(24);
    expect(t.counted.homes).toBe(1);
    expect(t.merged).toBe(1);
  });

  it('counts a building with an unknown unit count as one unit and says so (RULE-02)', () => {
    const t = countDamage([
      rec({
        kind: 'assessment',
        verification: 'field_verified',
        homeType: 'multi_family',
        wholeBuilding: true,
        units: null,
        parcelId: 'B-3',
      }),
    ]);
    expect(t.counted.units).toBe(1);
    expect(t.counted.unknownUnitBuildings).toBe(1);
  });

  it('treats an assessment made for a report as the same home', () => {
    const report = rec({
      parcelId: null,
      addressKey: '5 pine||63003',
      verification: 'self_reported',
      reviewState: 'submitted',
    });
    const t = countDamage([
      report,
      rec({
        kind: 'assessment',
        reportId: report.id,
        parcelId: 'P-99',
        verification: 'field_verified',
        degree: 'major',
        tenure: 'unknown',
      }),
    ]);
    expect(t.counted.units).toBe(1);
    expect(t.merged).toBe(1);
    expect(t.shownSeparately.selfReported).toBe(0);
  });

  it('lets a home owner’s report stand for the home over a witness observation', () => {
    const t = countDamage([
      rec({ parcelId: 'P-7', relationship: 'witness', verification: 'desktop_verified' }),
      rec({ parcelId: 'P-7', verification: 'self_reported', reviewState: 'submitted' }),
    ]);
    expect(t.shownSeparately.witness).toBe(0);
    expect(t.shownSeparately.selfReported).toBe(1);
  });
});

describe('unknown is a category, never zero (RULE-02)', () => {
  it('reports tenure, insurance and home type as given, unknown included, in cells that add up', () => {
    const t = countDamage([
      rec({ tenure: 'renter', insurance: 'uninsured', homeType: 'manufactured' }),
      rec({ tenure: 'unknown', insurance: 'unknown', homeType: 'unknown' }),
      rec({ tenure: 'renter', insurance: 'uninsured', homeType: 'manufactured' }),
    ]);
    expect(t.counted.cells).toEqual([
      expect.objectContaining({
        tenure: 'renter',
        insurance: 'uninsured',
        homeType: 'manufactured',
        units: 2,
      }),
      expect.objectContaining({
        tenure: 'unknown',
        insurance: 'unknown',
        homeType: 'unknown',
        units: 1,
      }),
    ]);
    expect(t.counted.cells.reduce((s, c) => s + c.units, 0)).toBe(t.counted.units);
  });

  it('adds up by tract, with no tract as its own row', () => {
    const t = countDamage([
      rec({ tractGeoid: '29999000200', degree: 'minor' }),
      rec({ tractGeoid: '29999000200', degree: 'major' }),
      rec({ tractGeoid: null }),
    ]);
    expect(t.counted.byTract).toEqual([
      {
        tractGeoid: '29999000200',
        units: 2,
        byDegree: { affected: 0, minor: 1, major: 1, destroyed: 0 },
      },
      { tractGeoid: null, units: 1, byDegree: { affected: 0, minor: 0, major: 1, destroyed: 0 } },
    ]);
  });

  it('reads answers into categories', () => {
    const v = (value: unknown) => ({ kind: 'value', value });
    expect(homeTypeFromAnswer(v('apartment_condo'))).toBe('multi_family');
    expect(homeTypeFromAnswer({ kind: 'unknown' })).toBe('unknown');
    expect(homeTypeFromAnswer(v('business'))).toBe('non_residential');
    expect(tenureFromAnswer(v('rent'))).toBe('renter');
    expect(tenureFromAnswer(null)).toBe('unknown');
    expect(insuranceFromAnswer(v(['flood']))).toBe('insured');
    expect(insuranceFromAnswer(v(['none']))).toBe('uninsured');
    expect(insuranceFromAnswer(v(['none', 'not_sure']))).toBe('unknown');
    expect(insuranceFromAnswer(v(['not_sure']))).toBe('unknown');
  });
});

describe('the same records, the same answer (AC-14C)', () => {
  it('does not depend on the order of the records', () => {
    const records = [
      rec({ parcelId: 'X-1', degree: 'minor' }),
      rec({ parcelId: 'X-1', degree: 'major', verification: 'field_verified' }),
      rec({ verification: 'self_reported', reviewState: 'submitted' }),
      rec({ homeType: 'multi_family', addressKey: 'a||1|1', parcelId: 'B-9' }),
      rec({
        kind: 'assessment',
        verification: 'field_verified',
        homeType: 'multi_family',
        wholeBuilding: true,
        units: 8,
        parcelId: 'B-9',
      }),
    ];
    const a = countDamage(records);
    const b = countDamage([...records].reverse());
    expect(b).toEqual(a);
    expect(homeKeyOf(records[3]!)).toBe('unit:a||1|1');
  });
});
