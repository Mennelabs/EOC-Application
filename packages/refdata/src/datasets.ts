/**
 * Reference datasets (layer-6 plan §3, ADR-0039): the normalized row each
 * connector and each file import produces, checked before anything is
 * written. Unknown values are null, never zero (RULE-02). Geometry is GeoJSON
 * in WGS84 (EPSG:4326).
 */
import { z } from 'zod';
import type { ReferenceDataset } from '@cg/db';

export const DATASETS = [
  'tract',
  'tract_profile',
  'structure',
  'flood_zone',
  'facility',
  'declaration',
  'nfip_summary',
  'risk',
  'alert',
  'power_outage',
] as const satisfies readonly ReferenceDataset[];

export type Dataset = (typeof DATASETS)[number];

const position = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .rest(z.number());
const ring = z.array(position).min(4);
export const pointGeometry = z.object({ type: z.literal('Point'), coordinates: position });
export const areaGeometry = z.union([
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1)).min(1) }),
]);
export type PointGeometry = z.infer<typeof pointGeometry>;
export type AreaGeometry = z.infer<typeof areaGeometry>;

const count = z.number().int().min(0).nullable().default(null);
const pct = z.number().min(0).max(100).nullable().default(null);
const text = z.string().trim().min(1).nullable().default(null);
const day = z.iso.date().nullable().default(null);
const moment = z.iso.datetime({ offset: true }).nullable().default(null);
const numbers = z.record(z.string(), z.number()).default({});

export const ROW_SCHEMAS = {
  tract: z.object({
    geoid: z.string().regex(/^[0-9]{11}$/),
    name: text,
    stateFips: z.string().regex(/^[0-9]{2}$/),
    countyFips: z.string().regex(/^[0-9]{5}$/),
    landM2: count,
    geometry: areaGeometry,
  }),
  tract_profile: z.object({
    geoid: z.string().regex(/^[0-9]{11}$/),
    population: count,
    households: count,
    renterHouseholds: count,
    medianHouseholdIncome: count,
    povertyPct: pct,
    snapHouseholdsPct: pct,
    ssiHouseholdsPct: pct,
    age65Pct: pct,
    disabilityPct: pct,
    limitedEnglishHouseholds: count,
    noVehicleHouseholds: count,
    languages: numbers,
    moe: numbers,
  }),
  structure: z.object({
    sourceId: z.string().min(1),
    geometry: pointGeometry,
    occupancy: text,
    homeType: z
      .enum([
        'single_family',
        'multi_family',
        'manufactured',
        'commercial',
        'public',
        'other',
        'unknown',
      ])
      .default('unknown'),
    units: count,
    stories: z.number().min(0).max(200).nullable().default(null),
    foundation: text,
    valueUsd: z.number().min(0).nullable().default(null),
    yearBuilt: z.number().int().min(1600).max(2100).nullable().default(null),
    tractGeoid: z
      .string()
      .regex(/^[0-9]{11}$/)
      .nullable()
      .default(null),
  }),
  flood_zone: z.object({
    zone: z.string().min(1),
    specialHazard: z.boolean(),
    baseFloodElevation: z.number().nullable().default(null),
    geometry: areaGeometry,
  }),
  facility: z.object({
    sourceId: z.string().min(1),
    kind: z.enum([
      'hospital',
      'nursing_home',
      'home_health',
      'dialysis',
      'school',
      'child_care',
      'eldercare',
      'fire_ems',
      'police',
      'water',
      'wastewater',
      'shelter',
      'other',
    ]),
    name: z.string().trim().min(1),
    address: text,
    city: text,
    postal: text,
    beds: count,
    geometry: pointGeometry.nullable().default(null),
  }),
  declaration: z.object({
    disasterNumber: z.number().int().positive(),
    declarationType: z.string().min(1),
    title: text,
    incidentType: text,
    declaredOn: day,
    incidentBegin: day,
    incidentEnd: day,
    programs: z.array(z.string()).default([]),
    designatedArea: text,
    countyFips: z
      .string()
      .regex(/^[0-9]{5}$/)
      .nullable()
      .default(null),
  }),
  nfip_summary: z.object({
    areaKind: z.enum(['county', 'tract']),
    areaId: z.string().min(1),
    policies: count,
    residentialPolicies: count,
    coverageUsd: z.number().min(0).nullable().default(null),
    asOf: day,
  }),
  risk: z.object({
    geoid: z.string().min(1),
    nriRiskScore: z.number().nullable().default(null),
    nriRiskRating: text,
    sviOverall: z.number().min(0).max(1).nullable().default(null),
    sviThemes: numbers,
  }),
  alert: z.object({
    alertId: z.string().min(1),
    event: z.string().min(1),
    severity: text,
    urgency: text,
    headline: text,
    areaDescription: text,
    effective: moment,
    expires: moment,
    geometry: areaGeometry.nullable().default(null),
  }),
  power_outage: z.object({
    countyFips: z.string().regex(/^[0-9]{5}$/),
    utility: text,
    customersOut: count,
    customersServed: count,
    asOf: z.iso.datetime({ offset: true }),
  }),
} as const satisfies Record<Dataset, z.ZodType>;

export type RowOf<D extends Dataset> = z.infer<(typeof ROW_SCHEMAS)[D]>;
export type AnyRow = { [D in Dataset]: RowOf<D> }[Dataset];

/** A row as the source gave it, before checking. */
export type RawRow = Record<string, unknown>;

export function isDataset(v: unknown): v is Dataset {
  return typeof v === 'string' && (DATASETS as readonly string[]).includes(v);
}

/** Checks one row; the issues name fields, never values (a source row may be large). */
export function checkRow<D extends Dataset>(
  dataset: D,
  raw: RawRow,
): { ok: true; row: RowOf<D> } | { ok: false; issues: { field: string; message: string }[] } {
  const r = ROW_SCHEMAS[dataset].safeParse(raw);
  if (r.success) return { ok: true, row: r.data as RowOf<D> };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({
      field: i.path.map(String).join('.') || '(row)',
      message: i.message,
    })),
  };
}
