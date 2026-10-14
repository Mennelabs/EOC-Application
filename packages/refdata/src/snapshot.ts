/**
 * Snapshot writer (ADR-0039, RULE-10, SCL-06). A pull or an import becomes a
 * versioned snapshot: the snapshot row is recorded as `loading`, every row is
 * checked against the dataset schema and inserted in one transaction, and
 * only then does the snapshot become `ready` and `refdata_current` point at
 * it (the previous one becomes `superseded`). Any failure rolls the rows back
 * and marks the snapshot `failed` with a short reason; the current pointer is
 * untouched, so screens and reports keep the last good data. The checksum is
 * a SHA-256 over the checked rows in order, so a snapshot can be shown to be
 * the one an issued report cites. Runs as the system (the worker's role).
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import { checkRow, type AnyRow, type Dataset, type RawRow, type RowOf } from './datasets.ts';

type Trx = Transaction<Database>;

export interface SnapshotMeta {
  tenantId: string;
  dataset: Dataset;
  source: string;
  mode: 'pull' | 'recorded' | 'import';
  scope: Record<string, unknown>;
  vintage: string | null;
  sourceUrl: string | null;
  licence: string;
  importId?: string | null;
  createdBy?: string | null;
}

export class RowRejected extends Error {
  readonly index: number;
  readonly issues: { field: string; message: string }[];
  constructor(index: number, issues: { field: string; message: string }[]) {
    super(
      `row ${index + 1}: ${issues
        .slice(0, 3)
        .map((i) => `${i.field} ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'RowRejected';
    this.index = index;
    this.issues = issues;
  }
}

export interface SnapshotResult {
  snapshotId: string;
  status: 'ready' | 'failed';
  rowCount: number;
  checksum: string | null;
  error: string | null;
}

const BATCH = 500;

const geo = (g: unknown) => sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(g)}), 4326)`;
const multi = (g: unknown) => sql`ST_Multi(${geo(g)})`;
const json = (v: unknown) => JSON.stringify(v);

/** One checked row as the column values of its table (geometry as SQL). */
function columns(dataset: Dataset, row: AnyRow): Record<string, unknown> {
  switch (dataset) {
    case 'tract': {
      const r = row as RowOf<'tract'>;
      return {
        geoid: r.geoid,
        name: r.name,
        state_fips: r.stateFips,
        county_fips: r.countyFips,
        land_m2: r.landM2,
        geom: multi(r.geometry),
      };
    }
    case 'tract_profile': {
      const r = row as RowOf<'tract_profile'>;
      return {
        geoid: r.geoid,
        population: r.population,
        households: r.households,
        renter_households: r.renterHouseholds,
        median_household_income: r.medianHouseholdIncome,
        poverty_pct: r.povertyPct,
        snap_households_pct: r.snapHouseholdsPct,
        ssi_households_pct: r.ssiHouseholdsPct,
        age65_pct: r.age65Pct,
        disability_pct: r.disabilityPct,
        limited_english_households: r.limitedEnglishHouseholds,
        no_vehicle_households: r.noVehicleHouseholds,
        languages: json(r.languages),
        moe: json(r.moe),
      };
    }
    case 'structure': {
      const r = row as RowOf<'structure'>;
      return {
        source_id: r.sourceId,
        geom: geo(r.geometry),
        occupancy: r.occupancy,
        home_type: r.homeType,
        units: r.units,
        stories: r.stories,
        foundation: r.foundation,
        value_usd: r.valueUsd,
        year_built: r.yearBuilt,
        tract_geoid: r.tractGeoid,
      };
    }
    case 'flood_zone': {
      const r = row as RowOf<'flood_zone'>;
      return {
        zone: r.zone,
        special_hazard: r.specialHazard,
        base_flood_elevation: r.baseFloodElevation,
        geom: multi(r.geometry),
      };
    }
    case 'facility': {
      const r = row as RowOf<'facility'>;
      return {
        source_id: r.sourceId,
        kind: r.kind,
        name: r.name,
        address: r.address,
        city: r.city,
        postal: r.postal,
        beds: r.beds,
        geom: r.geometry ? geo(r.geometry) : null,
      };
    }
    case 'declaration': {
      const r = row as RowOf<'declaration'>;
      return {
        disaster_number: r.disasterNumber,
        declaration_type: r.declarationType,
        title: r.title,
        incident_type: r.incidentType,
        declared_on: r.declaredOn,
        incident_begin: r.incidentBegin,
        incident_end: r.incidentEnd,
        programs: r.programs,
        designated_area: r.designatedArea,
        county_fips: r.countyFips,
      };
    }
    case 'nfip_summary': {
      const r = row as RowOf<'nfip_summary'>;
      return {
        area_kind: r.areaKind,
        area_id: r.areaId,
        policies: r.policies,
        residential_policies: r.residentialPolicies,
        coverage_usd: r.coverageUsd,
        as_of: r.asOf,
      };
    }
    case 'risk': {
      const r = row as RowOf<'risk'>;
      return {
        geoid: r.geoid,
        nri_risk_score: r.nriRiskScore,
        nri_risk_rating: r.nriRiskRating,
        svi_overall: r.sviOverall,
        svi_themes: json(r.sviThemes),
      };
    }
    case 'alert': {
      const r = row as RowOf<'alert'>;
      return {
        alert_id: r.alertId,
        event: r.event,
        severity: r.severity,
        urgency: r.urgency,
        headline: r.headline,
        area_description: r.areaDescription,
        effective: r.effective,
        expires: r.expires,
        geom: r.geometry ? multi(r.geometry) : null,
      };
    }
    case 'power_outage': {
      const r = row as RowOf<'power_outage'>;
      return {
        county_fips: r.countyFips,
        utility: r.utility,
        customers_out: r.customersOut,
        customers_served: r.customersServed,
        as_of: r.asOf,
      };
    }
  }
}

const TABLE = {
  tract: 'cg.ref_tract',
  tract_profile: 'cg.ref_tract_profile',
  structure: 'cg.ref_structure',
  flood_zone: 'cg.ref_flood_zone',
  facility: 'cg.ref_facility',
  declaration: 'cg.ref_declaration',
  nfip_summary: 'cg.ref_nfip_summary',
  risk: 'cg.ref_risk',
  alert: 'cg.ref_alert',
  power_outage: 'cg.ref_power_outage',
} as const satisfies Record<Dataset, keyof Database>;

/** Stable JSON (sorted keys) so the checksum does not depend on property order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

async function insertBatch(
  trx: Trx,
  dataset: Dataset,
  base: Record<string, unknown>,
  rows: AnyRow[],
) {
  if (rows.length === 0) return;
  await trx
    .insertInto(TABLE[dataset])
    .values(rows.map((r) => ({ ...base, ...columns(dataset, r) })) as never)
    .execute();
}

/** Short and free of values from the source (a row may hold anything). */
function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, 500);
}

export async function writeSnapshot(
  db: Kysely<Database>,
  meta: SnapshotMeta,
  rows: AsyncIterable<RawRow> | Iterable<RawRow>,
): Promise<SnapshotResult> {
  const snapshotId = await withTenant(db, { tenantId: meta.tenantId }, async (trx) => {
    const created = await trx
      .insertInto('cg.refdata_snapshot')
      .values({
        tenant_id: meta.tenantId,
        dataset: meta.dataset,
        source: meta.source,
        mode: meta.mode,
        scope: JSON.stringify(meta.scope),
        vintage: meta.vintage,
        source_url: meta.sourceUrl,
        licence: meta.licence,
        import_id: meta.importId ?? null,
        created_by: meta.createdBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return created.id;
  });

  try {
    const done = await withTenant(db, { tenantId: meta.tenantId }, async (trx) => {
      const hash = createHash('sha256');
      const base = { snapshot_id: snapshotId, tenant_id: meta.tenantId };
      let batch: AnyRow[] = [];
      let index = 0;
      for await (const raw of rows) {
        const checked = checkRow(meta.dataset, raw);
        if (!checked.ok) throw new RowRejected(index, checked.issues);
        hash.update(canonical(checked.row)).update('\n');
        batch.push(checked.row);
        index++;
        if (batch.length >= BATCH) {
          await insertBatch(trx, meta.dataset, base, batch);
          batch = [];
        }
      }
      await insertBatch(trx, meta.dataset, base, batch);
      const checksum = hash.digest('hex');
      await trx
        .updateTable('cg.refdata_snapshot')
        .set({ status: 'ready', row_count: index, checksum, ready_at: new Date() })
        .where('id', '=', snapshotId)
        .execute();
      const previous = await trx
        .selectFrom('cg.refdata_current')
        .select('snapshot_id')
        .where('tenant_id', '=', meta.tenantId)
        .where('dataset', '=', meta.dataset)
        .executeTakeFirst();
      if (previous)
        await trx
          .updateTable('cg.refdata_snapshot')
          .set({ status: 'superseded' })
          .where('id', '=', previous.snapshot_id)
          .execute();
      await trx
        .insertInto('cg.refdata_current')
        .values({ tenant_id: meta.tenantId, dataset: meta.dataset, snapshot_id: snapshotId })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'dataset'])
            .doUpdateSet({ snapshot_id: snapshotId, switched_at: new Date() }),
        )
        .execute();
      return { rowCount: index, checksum };
    });
    return { snapshotId, status: 'ready', ...done, error: null };
  } catch (err) {
    const error = reasonOf(err);
    await withTenant(db, { tenantId: meta.tenantId }, (trx) =>
      trx
        .updateTable('cg.refdata_snapshot')
        .set({ status: 'failed', error })
        .where('id', '=', snapshotId)
        .execute(),
    );
    return { snapshotId, status: 'failed', rowCount: 0, checksum: null, error };
  }
}
