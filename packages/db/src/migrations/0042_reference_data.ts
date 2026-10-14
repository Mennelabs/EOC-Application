/**
 * 0042 reference data (layer-6 plan §3–§4, task A; ADR-0039, SCL-09, SCL-13,
 * DCL:DEC-05/06/07, CON-07, EQ-11, RULE-10, SCL-06, SEC-11, SEC-13): public
 * facts about a county that nobody enters by hand (census tracts and their
 * population profile, structures, flood zones, critical facilities, earlier
 * declarations, flood-insurance coverage, risk indexes, weather alerts, power
 * outages), filled either by a connector pulling a free federal source or by
 * a file import, always as a versioned per-tenant snapshot:
 * - `refdata_snapshot` records source, mode, scope, vintage, URL, licence,
 *   checksum and status; `refdata_current` points at the snapshot in use, so
 *   a failed pull leaves the last good one in place (SCL-06);
 * - one row table per dataset, keyed by snapshot and never edited; an issued
 *   report cites snapshot ids, and a cited snapshot is never pruned (RULE-10);
 * - `refdata_import` holds an uploaded file's mapping and validation result.
 * Only the worker (system) writes snapshots and rows; staff upload imports
 * and read. Every column is in the dictionary; superseded, uncited snapshots
 * fall under the new `reference_data` retention category.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';
import { FIELD_RECORDS_ROW, retentionFunction } from './0028_field_roster.ts';
import { SAFETY_COMMS_ROWS } from './0031_hazards_safety_comms.ts';
import { BADGES_ROW } from './0032_reminders_badges.ts';
import { CHILD_RECORDS_ROW } from './0033_field_records.ts';

export const REFERENCE_DATA_ROW = `,\n        (p_tenant, 'reference_data', interval '90 days', 'duration', 'ADR-0039: superseded reference snapshots no issued report cites', p_actor)`;

export const REFERENCE_DATASETS = [
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
] as const;

const datasetCheck = REFERENCE_DATASETS.map((d) => `'${d}'`).join(', ');

const stamped = `
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid`;

/** Rows of one snapshot: read by the tenant, written only by the system, never edited. */
async function rowTable(db: Kysely<unknown>, name: string, columns: string): Promise<void> {
  await sql
    .raw(
      `create table cg.${name} (
      id bigint generated always as identity primary key,
      snapshot_id uuid not null references cg.refdata_snapshot(id) on delete cascade,
      tenant_id uuid not null references cg.tenant(id),
      ${columns}
    )`,
    )
    .execute(db);
  await sql.raw(`create index ${name}_snapshot_idx on cg.${name} (snapshot_id)`).execute(db);
  await systemWritten(db, name);
}

/** Tenant reads; inserts, updates and deletes only by the system (the worker). */
export async function systemWritten(db: Kysely<unknown>, name: string): Promise<void> {
  await sql.raw(`select cg.apply_tenant_rls('cg.${name}')`).execute(db);
  for (const p of ['tenant_insert', 'tenant_update', 'tenant_delete'])
    await sql.raw(`drop policy ${p} on cg.${name}`).execute(db);
  await sql
    .raw(`create policy system_insert on cg.${name} for insert with check (cg.is_system())`)
    .execute(db);
  await sql
    .raw(
      `create policy system_update on cg.${name} for update using (cg.is_system()) with check (cg.is_system())`,
    )
    .execute(db);
  await sql
    .raw(`create policy system_delete on cg.${name} for delete using (cg.is_system())`)
    .execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Uploaded files (CSV, GeoJSON, GeoPackage, zipped Shapefile): staff upload and map columns;
  // the worker validates and applies.
  // The client's own id makes a resent upload request return the same import (FR-00.06).
  await sql
    .raw(
      `create table cg.refdata_import (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      dataset text not null check (dataset in (${datasetCheck})),
      execution_id uuid not null,
      file_name text not null,
      object_key text not null,
      format text not null check (format in ('csv', 'geojson', 'gpkg', 'shapefile')),
      bytes integer not null check (bytes > 0),
      columns jsonb not null default '[]'::jsonb,
      mapping jsonb not null default '{}'::jsonb,
      vintage text,
      licence text not null,
      status text not null default 'uploading' check (status in ('uploading', 'uploaded', 'validating', 'validated', 'invalid', 'applying', 'applied', 'failed')),
      errors jsonb not null default '[]'::jsonb,
      row_count integer not null default 0,
      snapshot_id uuid,${stamped},
      unique (tenant_id, execution_id)
    )`,
    )
    .execute(db);
  await sql`create index refdata_import_tenant_idx on cg.refdata_import (tenant_id, created_at desc)`.execute(
    db,
  );
  await sql`create trigger refdata_import_touch before update on cg.refdata_import for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.refdata_import')`.execute(db);
  await sql`drop policy tenant_delete on cg.refdata_import`.execute(db);

  await sql
    .raw(
      `create table cg.refdata_snapshot (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      dataset text not null check (dataset in (${datasetCheck})),
      source text not null,
      mode text not null check (mode in ('pull', 'recorded', 'import')),
      scope jsonb not null default '{}'::jsonb,
      vintage text,
      source_url text,
      licence text not null,
      status text not null default 'loading' check (status in ('loading', 'ready', 'failed', 'superseded')),
      error text,
      row_count integer not null default 0,
      checksum text,
      retrieved_at timestamptz not null default now(),
      ready_at timestamptz,
      cited boolean not null default false,
      import_id uuid references cg.refdata_import(id),${stamped}
    )`,
    )
    .execute(db);
  await sql`create index refdata_snapshot_tenant_idx on cg.refdata_snapshot (tenant_id, dataset, retrieved_at desc)`.execute(
    db,
  );
  await sql`create trigger refdata_snapshot_touch before update on cg.refdata_snapshot for each row execute function cg.touch()`.execute(
    db,
  );
  await systemWritten(db, 'refdata_snapshot');
  await sql`alter table cg.refdata_import add constraint refdata_import_snapshot_fk foreign key (snapshot_id) references cg.refdata_snapshot(id) on delete set null`.execute(
    db,
  );

  await sql
    .raw(
      `create table cg.refdata_current (
      tenant_id uuid not null references cg.tenant(id),
      dataset text not null check (dataset in (${datasetCheck})),
      snapshot_id uuid not null references cg.refdata_snapshot(id),
      switched_at timestamptz not null default now(),
      primary key (tenant_id, dataset)
    )`,
    )
    .execute(db);
  await systemWritten(db, 'refdata_current');

  await rowTable(
    db,
    'ref_tract',
    `geoid text not null check (geoid ~ '^[0-9]{11}$'),
      name text,
      state_fips text not null check (state_fips ~ '^[0-9]{2}$'),
      county_fips text not null check (county_fips ~ '^[0-9]{5}$'),
      land_m2 bigint,
      geom geometry(MultiPolygon, 4326) not null`,
  );
  await sql`create index ref_tract_geom_idx on cg.ref_tract using gist (geom)`.execute(db);
  await sql`create index ref_tract_geoid_idx on cg.ref_tract (snapshot_id, geoid)`.execute(db);

  // Margins of error stay with the estimates (ACS); unknown is null, never zero (RULE-02).
  await rowTable(
    db,
    'ref_tract_profile',
    `geoid text not null check (geoid ~ '^[0-9]{11}$'),
      population integer,
      households integer,
      renter_households integer,
      median_household_income integer,
      poverty_pct numeric(5, 2),
      snap_households_pct numeric(5, 2),
      ssi_households_pct numeric(5, 2),
      age65_pct numeric(5, 2),
      disability_pct numeric(5, 2),
      limited_english_households integer,
      no_vehicle_households integer,
      languages jsonb not null default '{}'::jsonb,
      moe jsonb not null default '{}'::jsonb`,
  );
  await sql`create index ref_tract_profile_geoid_idx on cg.ref_tract_profile (snapshot_id, geoid)`.execute(
    db,
  );

  await rowTable(
    db,
    'ref_structure',
    `source_id text not null,
      geom geometry(Point, 4326) not null,
      occupancy text,
      home_type text not null default 'unknown' check (home_type in ('single_family', 'multi_family', 'manufactured', 'commercial', 'public', 'other', 'unknown')),
      units integer check (units >= 0),
      stories numeric(4, 1),
      foundation text,
      value_usd bigint,
      year_built integer,
      tract_geoid text`,
  );
  await sql`create index ref_structure_geom_idx on cg.ref_structure using gist (geom)`.execute(db);

  await rowTable(
    db,
    'ref_flood_zone',
    `zone text not null,
      special_hazard boolean not null,
      base_flood_elevation numeric(7, 2),
      geom geometry(MultiPolygon, 4326) not null`,
  );
  await sql`create index ref_flood_zone_geom_idx on cg.ref_flood_zone using gist (geom)`.execute(
    db,
  );

  // DCL:DEC-07 facility and service types (roads and power are services, not facilities).
  await rowTable(
    db,
    'ref_facility',
    `source_id text not null,
      kind text not null check (kind in ('hospital', 'nursing_home', 'home_health', 'dialysis', 'school', 'child_care', 'eldercare', 'fire_ems', 'police', 'water', 'wastewater', 'shelter', 'other')),
      name text not null,
      address text,
      city text,
      postal text,
      beds integer,
      geom geometry(Point, 4326)`,
  );
  await sql`create index ref_facility_geom_idx on cg.ref_facility using gist (geom)`.execute(db);

  await rowTable(
    db,
    'ref_declaration',
    `disaster_number integer not null,
      declaration_type text not null,
      title text,
      incident_type text,
      declared_on date,
      incident_begin date,
      incident_end date,
      programs text[] not null default '{}',
      designated_area text,
      county_fips text`,
  );

  await rowTable(
    db,
    'ref_nfip_summary',
    `area_kind text not null check (area_kind in ('county', 'tract')),
      area_id text not null,
      policies integer,
      residential_policies integer,
      coverage_usd bigint,
      as_of date`,
  );

  await rowTable(
    db,
    'ref_risk',
    `geoid text not null,
      nri_risk_score numeric(6, 2),
      nri_risk_rating text,
      svi_overall numeric(5, 4),
      svi_themes jsonb not null default '{}'::jsonb`,
  );

  await rowTable(
    db,
    'ref_alert',
    `alert_id text not null,
      event text not null,
      severity text,
      urgency text,
      headline text,
      area_description text,
      effective timestamptz,
      expires timestamptz,
      geom geometry(MultiPolygon, 4326)`,
  );

  await rowTable(
    db,
    'ref_power_outage',
    `county_fips text not null check (county_fips ~ '^[0-9]{5}$'),
      utility text,
      customers_out integer,
      customers_served integer,
      as_of timestamptz not null`,
  );

  await sql
    .raw(
      retentionFunction(
        FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS + BADGES_ROW + CHILD_RECORDS_ROW + REFERENCE_DATA_ROW,
      ),
    )
    .execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'ref_power_outage',
    'ref_alert',
    'ref_risk',
    'ref_nfip_summary',
    'ref_declaration',
    'ref_facility',
    'ref_flood_zone',
    'ref_structure',
    'ref_tract_profile',
    'ref_tract',
    'refdata_current',
  ])
    await sql.raw(`drop table if exists cg.${t}`).execute(db);
  await sql`alter table cg.refdata_import drop constraint if exists refdata_import_snapshot_fk`.execute(
    db,
  );
  await sql`drop table if exists cg.refdata_snapshot`.execute(db);
  await sql`drop table if exists cg.refdata_import`.execute(db);
  await sql`delete from cg.retention_policy where data_category = 'reference_data' and note like '%:%'`.execute(
    db,
  );
  await sql
    .raw(retentionFunction(FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS + BADGES_ROW + CHILD_RECORDS_ROW))
    .execute(db);
  await loadDictionary(db);
}
