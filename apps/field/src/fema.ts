/**
 * The FEMA details on the assessment screen (DCL:DEC-17; docs/05 per-home
 * fields): water depth at the basement, first floor and crawl space in feet
 * and inches, homes in an apartment building, who lives there, insurance,
 * utilities out, tribal ownership where the county asks it, and business
 * details. Everything is optional: a blank stays "not recorded", which the
 * counts show as unknown, never as zero. Values that are not a depth or a
 * count are named back to the volunteer instead of being saved.
 */
import {
  BUSINESS_DAYS_CLOSED_MAX,
  BUSINESS_EMPLOYEES_MAX,
  FLOOD_LOCATIONS,
  UNITS_MAX,
  floodDepthKey,
  toInches,
  type FloodLocation,
  type InsuranceType,
  type Occupancy,
  type TribalOwnership,
  type YesNoUnknown,
} from '@cg/field-core';
import type { Structure } from './assessment';
import type { MessageKey } from './i18n';

export interface FemaState {
  depth: Record<FloodLocation, { feet: string; inches: string }>;
  units: string;
  occupancy: Occupancy | null;
  insurance: InsuranceType[];
  utilitiesOut: YesNoUnknown | null;
  tribal: TribalOwnership | null;
  employees: string;
  daysClosed: string;
}

export const emptyFema = (): FemaState => ({
  depth: {
    basement: { feet: '', inches: '' },
    first_floor: { feet: '', inches: '' },
    crawl_space: { feet: '', inches: '' },
  },
  units: '',
  occupancy: null,
  insurance: [],
  utilitiesOut: null,
  tribal: null,
  employees: '',
  daysClosed: '',
});

/** Which questions fit this home: units for apartment buildings, business details for businesses. */
export function femaQuestions(structure: Structure, tribalOwnership: boolean) {
  const business = structure === 'commercial';
  const home = !business && structure !== 'public';
  return {
    units: structure === 'apartment_building',
    household: home,
    business,
    tribal: tribalOwnership && structure !== 'public',
  };
}

/** "None" and "not sure" stand alone; choosing a coverage clears them, and the other way round. */
export function toggleInsurance(list: InsuranceType[], v: InsuranceType): InsuranceType[] {
  if (list.includes(v)) return list.filter((x) => x !== v);
  if (v === 'none' || v === 'not_sure') return [v];
  return [...list.filter((x) => x !== 'none' && x !== 'not_sure'), v];
}

export interface Problem {
  key: MessageKey;
  params?: Record<string, string>;
}

const count = (s: string, max: number): number | null | 'invalid' => {
  const v = s.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : 'invalid';
};

/** The observations to save, and what needs fixing first (nothing is saved while a problem stands). */
export function femaObservations(
  s: FemaState,
  structure: Structure,
  tribalOwnership: boolean,
  depthLabel: (l: FloodLocation) => string,
): { observations: Record<string, number | string | string[]>; problems: Problem[] } {
  const q = femaQuestions(structure, tribalOwnership);
  const out: Record<string, number | string | string[]> = {};
  const problems: Problem[] = [];
  for (const l of FLOOD_LOCATIONS) {
    const v = toInches(s.depth[l].feet, s.depth[l].inches);
    if (v === 'invalid')
      problems.push({ key: 'fema.depth.invalid', params: { where: depthLabel(l) } });
    else if (v !== null) out[floodDepthKey(l)] = v;
  }
  if (q.units) {
    const v = count(s.units, UNITS_MAX);
    if (v === 'invalid' || v === 0) problems.push({ key: 'fema.units.invalid' });
    else if (v !== null) out['units'] = v;
  }
  if (q.household) {
    if (s.occupancy) out['occupancy'] = s.occupancy;
    if (s.insurance.length) out['insurance'] = s.insurance;
  }
  if (s.utilitiesOut) out['utilities_out'] = s.utilitiesOut;
  if (q.tribal && s.tribal) out['tribal_ownership'] = s.tribal;
  if (q.business) {
    const e = count(s.employees, BUSINESS_EMPLOYEES_MAX);
    const d = count(s.daysClosed, BUSINESS_DAYS_CLOSED_MAX);
    if (e === 'invalid') problems.push({ key: 'fema.employees.invalid' });
    else if (e !== null) out['business_employees'] = e;
    if (d === 'invalid') problems.push({ key: 'fema.daysClosed.invalid' });
    else if (d !== null) out['business_days_closed'] = d;
  }
  return { observations: out, problems };
}
