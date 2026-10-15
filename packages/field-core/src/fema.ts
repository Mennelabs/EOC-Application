/**
 * The per-home details FEMA's damage assessment asks for that a field team
 * records (DCL:DEC-17; docs/05 "Per-home fields"; FLD-08, FLD-10): water
 * depth at the basement, first floor and crawl space in feet and inches,
 * units in a multi-family building, occupancy, insurance types, utilities
 * out, tribal ownership for tenants with tribal lands, business details and
 * why a home could not be reached. One vocabulary for the phone, the API
 * that checks it and the counts built on it. Values match the resident
 * intake answers where both ask the same thing (occupancy, insurance), so
 * one count reads both.
 */

/** Why a home could not be reached; FEMA asks whether a private or a public road or bridge blocked it. */
export const CANT_REACH_REASONS = [
  'private_road_or_bridge',
  'public_road_or_bridge',
  'flood_water',
  'debris',
  'hazard',
  'no_permission',
  'other',
] as const;
export type CantReachReason = (typeof CANT_REACH_REASONS)[number];

/** Same values as the resident occupancy answer. */
export const OCCUPANCIES = ['own', 'rent', 'other', 'unknown'] as const;
export type Occupancy = (typeof OCCUPANCIES)[number];

/** Same values as the resident insurance answer, plus FEMA's "other riders". */
export const INSURANCE_TYPES = [
  'home_or_renters',
  'flood',
  'condo',
  'manufactured_home',
  'sewer_backup',
  'other_rider',
  'none',
  'not_sure',
] as const;
export type InsuranceType = (typeof INSURANCE_TYPES)[number];

export const YES_NO_UNKNOWN = ['yes', 'no', 'unknown'] as const;
export type YesNoUnknown = (typeof YES_NO_UNKNOWN)[number];

/** Asked only where the tenant has tribal lands (tenant config `field.tribal_ownership`). */
export const TRIBAL_OWNERSHIP = ['tribe', 'private', 'unknown'] as const;
export type TribalOwnership = (typeof TRIBAL_OWNERSHIP)[number];

export const FLOOD_LOCATIONS = ['basement', 'first_floor', 'crawl_space'] as const;
export type FloodLocation = (typeof FLOOD_LOCATIONS)[number];

/** Depths are kept in whole inches; 50 feet bounds a typing slip, not a flood. */
export const FLOOD_DEPTH_MAX_IN = 600;
export const UNITS_MAX = 2000;
export const BUSINESS_EMPLOYEES_MAX = 100_000;
export const BUSINESS_DAYS_CLOSED_MAX = 730;

export const floodDepthKey = (l: FloodLocation) => `flood_depth_${l}_in` as const;

/**
 * Feet and inches as typed into whole inches. Blank in both boxes is "not
 * measured" (null); anything that is not a depth is `invalid`, so the screen
 * can say so instead of saving a wrong number.
 */
export function toInches(feet: string, inches: string): number | null | 'invalid' {
  const f = feet.trim();
  const i = inches.trim();
  if (!f && !i) return null;
  const ft = f ? Number(f) : 0;
  const inch = i ? Number(i) : 0;
  if (!Number.isInteger(ft) || !Number.isInteger(inch) || ft < 0 || inch < 0 || inch > 11)
    return 'invalid';
  const total = ft * 12 + inch;
  return total <= FLOOD_DEPTH_MAX_IN ? total : 'invalid';
}

export function feetAndInches(total: number): { feet: number; inches: number } {
  return { feet: Math.floor(total / 12), inches: total % 12 };
}

/**
 * A resident's "can a car reach the home" answer, or a field reason, in the
 * can't-reach vocabulary; null when it names no reason.
 */
export function cantReachReasonOf(v: unknown): CantReachReason | null {
  if (v === 'no_private_road') return 'private_road_or_bridge';
  if (v === 'no_public_road') return 'public_road_or_bridge';
  return (CANT_REACH_REASONS as readonly unknown[]).includes(v) ? (v as CantReachReason) : null;
}
