/**
 * An event area's population profile and the reference snapshots to cite
 * (layer 6; DCL:DEC-06, EQ-11, RULE-02, RULE-10, NED-09). Shared by
 * `/refdata/profile` and the declaration view so both say the same thing:
 * the tracts the event's footprint touches, or else the tracts where its
 * reports are; shares weighted by population or households; a tract
 * without an estimate named, never counted as zero; low income a tract
 * figure only.
 */
import { z } from 'zod';

export const profileOut = z.object({
  geoid: z.string(),
  population: z.number().nullable(),
  households: z.number().nullable(),
  renterHouseholds: z.number().nullable(),
  medianHouseholdIncome: z.number().nullable(),
  povertyPct: z.number().nullable(),
  snapHouseholdsPct: z.number().nullable(),
  ssiHouseholdsPct: z.number().nullable(),
  age65Pct: z.number().nullable(),
  disabilityPct: z.number().nullable(),
  limitedEnglishHouseholds: z.number().nullable(),
  noVehicleHouseholds: z.number().nullable(),
  languages: z.record(z.string(), z.number()),
  moe: z.record(z.string(), z.number()),
});
export type ProfileRow = z.infer<typeof profileOut>;

export const citation = z
  .object({ snapshotId: z.uuid(), vintage: z.string().nullable(), retrievedAt: z.iso.datetime() })
  .nullable();

export const areaProfileOut = z.object({
  eventId: z.uuid(),
  basis: z.enum(['footprint', 'reports', 'none']),
  tracts: citation,
  profiles: citation,
  items: z.array(profileOut),
  missing: z.array(z.string()),
  total: z.object({
    tracts: z.number(),
    population: z.number().nullable(),
    households: z.number().nullable(),
    renterHouseholds: z.number().nullable(),
    povertyPct: z.number().nullable(),
    snapHouseholdsPct: z.number().nullable(),
    ssiHouseholdsPct: z.number().nullable(),
    age65Pct: z.number().nullable(),
    disabilityPct: z.number().nullable(),
    limitedEnglishHouseholds: z.number().nullable(),
    noVehicleHouseholds: z.number().nullable(),
  }),
});
export type AreaProfile = z.infer<typeof areaProfileOut>;

// The queries live in packages/reporting so the worker's FEMA package uses the same ones.
export { areaProfile, cite, currentSnapshot, profileOf } from '@cg/reporting';
