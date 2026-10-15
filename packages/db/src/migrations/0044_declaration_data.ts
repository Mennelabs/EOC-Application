/**
 * 0044 declaration data (layer-6 plan §4, task D; DCL:DEC-07, DEC-08,
 * DEC-10, DEC-14, DEC-16, DEC-17, FL-17): what staff add for a declaration
 * request beside the damage records.
 * - `declaration`: one per event; the incident type and period as staff
 *   enter them (separate from when the event was opened here), the areas
 *   requested, and drafts of Form 010-0-13 Boxes 8 and 9 within 3,000
 *   characters, labelled for state review; never submitted from here.
 * - `outage`: the infrastructure outage log (facility or service type from
 *   the DEC-07 list, start, expected and actual restoration; a suggestion
 *   from a feed waits for a person to confirm it).
 * - `casualty_count`: injured, missing and deceased as authorized staff
 *   enter them from an official source; append-only, the latest per kind is
 *   current and earlier entries stay as the record of corrections (DEC-08).
 * - `pa_site`: public damage sites with FEMA's category A–G, estimated or
 *   verified cost, percent complete, insured and other-federal-agency flags
 *   (DEC-10, DEC-17); field photos may document a site.
 * Every column is in the dictionary; RLS on every table.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

const stamped = `
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid`;

export const OUTAGE_KINDS = [
  'hospital',
  'water',
  'wastewater',
  'police',
  'fire_ems',
  'school',
  'child_care',
  'eldercare',
  'roads',
  'power',
] as const;

const PHOTO_BASE = `'field_assessment', 'hazard', 'mission', 'need', 'search_mark', 'placard', 'site', 'pet_intake', 'site_walkthrough', 'debris_ticket', 'inspection', 'road_status', 'canvass_visit'`;

async function touchAndRls(db: Kysely<unknown>, name: string): Promise<void> {
  await sql
    .raw(
      `create trigger ${name}_touch before update on cg.${name} for each row execute function cg.touch()`,
    )
    .execute(db);
  await sql.raw(`select cg.apply_tenant_rls('cg.${name}')`).execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `create table cg.declaration (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      incident_type text,
      incident_start date,
      incident_end date,
      requested_areas jsonb not null default '[]'::jsonb,
      box8_draft text check (char_length(box8_draft) <= 3000),
      box9_draft text check (char_length(box9_draft) <= 3000),
      review_label text not null default 'Draft for state review',${stamped},
      unique (tenant_id, event_id),
      check (incident_end is null or incident_start is null or incident_end >= incident_start)
    )`,
    )
    .execute(db);
  await touchAndRls(db, 'declaration');
  await sql`drop policy tenant_delete on cg.declaration`.execute(db);

  await sql
    .raw(
      `create table cg.outage (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      client_uuid uuid not null,
      kind text not null check (kind in (${OUTAGE_KINDS.map((k) => `'${k}'`).join(', ')})),
      facility_source_id text,
      facility_name text,
      description text,
      area text,
      customers_out integer check (customers_out >= 0),
      started_at timestamptz not null,
      expected_restoration_at timestamptz,
      restored_at timestamptz,
      source text not null default 'staff' check (source in ('staff', 'feed_suggestion', 'utility_report')),
      confirmed_by uuid,
      confirmed_at timestamptz,${stamped},
      unique (tenant_id, client_uuid),
      check (restored_at is null or restored_at >= started_at),
      check (source = 'staff' or confirmed_at is not null or confirmed_by is null)
    )`,
    )
    .execute(db);
  await sql`create index outage_event_idx on cg.outage (tenant_id, event_id, started_at)`.execute(
    db,
  );
  await touchAndRls(db, 'outage');
  await sql`drop policy tenant_delete on cg.outage`.execute(db);

  // Append-only: no update or delete policy (corrections are new entries; DEC-08).
  await sql`
    create table cg.casualty_count (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      kind text not null check (kind in ('injured', 'missing', 'deceased')),
      count integer not null check (count >= 0),
      official_source text not null check (char_length(official_source) >= 3),
      as_of timestamptz not null,
      note text,
      entered_by uuid not null,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index casualty_count_event_idx on cg.casualty_count (tenant_id, event_id, kind, as_of desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.casualty_count')`.execute(db);
  await sql`drop policy tenant_update on cg.casualty_count`.execute(db);
  await sql`drop policy tenant_delete on cg.casualty_count`.execute(db);

  await sql
    .raw(
      `create table cg.pa_site (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      client_uuid uuid not null,
      applicant text not null,
      applicant_tenant_id uuid references cg.tenant(id),
      name text not null,
      description text,
      category text not null check (category in ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
      geom geometry(Point, 4326),
      estimated_cost numeric(14, 2) check (estimated_cost >= 0),
      cost_basis text not null default 'estimate' check (cost_basis in ('estimate', 'verified')),
      percent_complete integer check (percent_complete between 0 and 100),
      insured text not null default 'unknown' check (insured in ('yes', 'no', 'unknown')),
      other_federal_agency text not null default 'unknown' check (other_federal_agency in ('yes', 'no', 'unknown')),
      debris_cubic_yards numeric(12, 1) check (debris_cubic_yards >= 0),
      status text not null default 'active' check (status in ('active', 'withdrawn')),${stamped},
      unique (tenant_id, client_uuid)
    )`,
    )
    .execute(db);
  await sql`create index pa_site_event_idx on cg.pa_site (tenant_id, event_id)`.execute(db);
  await sql`create index pa_site_geom_idx on cg.pa_site using gist (geom)`.execute(db);
  await touchAndRls(db, 'pa_site');
  await sql`drop policy tenant_delete on cg.pa_site`.execute(db);

  // A field photo may document a public damage site (DEC-10).
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${PHOTO_BASE}, 'pa_site'))`,
    )
    .execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.photo no force row level security`.execute(db);
  await sql`update cg.photo set field_record_type = null, field_record_id = null where field_record_type = 'pa_site'`.execute(
    db,
  );
  await sql`alter table cg.photo force row level security`.execute(db);
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${PHOTO_BASE}))`,
    )
    .execute(db);
  for (const t of ['pa_site', 'casualty_count', 'outage', 'declaration'])
    await sql.raw(`drop table if exists cg.${t}`).execute(db);
  await loadDictionary(db);
}
