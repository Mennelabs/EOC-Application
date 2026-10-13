/**
 * 0037 field assessments (layer-4 task I; FLD-04, FLD-05, FLD-07, FLD-08,
 * FLD-10, FLD-13, DCL:DEC-02/03, A7): what a field team saw at a property,
 * one record per visit, never overwriting another. The pin is snapped to a
 * parcel on the phone; the record keeps the parcel id, the position with its
 * accuracy and a USNG coordinate so search and rescue and FEMA teams find the
 * spot without an address. The degree of damage is chosen from pictures and
 * short descriptions for the home type (FLD-08), or "can't reach" from the
 * street sweep (FLD-10). A second record for the same property in the same
 * event is flagged for a reviewer (`duplicate_of`), never merged (FLD-13). A
 * linked resident report is verified only when a reviewer accepts the
 * assessment, and never by the person who recorded it (A7). No resident
 * personal details are collected. Photos taken in the field point at the
 * record they belong to. Every column is in the dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.field_assessment (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      client_uuid uuid not null,
      mission_id uuid references cg.mission(id),
      assignment_id uuid references cg.assignment(id),
      team_id uuid references cg.team(id),
      personnel_id uuid references cg.personnel(id),
      mode text not null default 'detailed' check (mode in ('sweep', 'detailed', 'validation')),
      parcel_id text,
      location_id uuid references cg.location(id),
      geom geometry(Point, 4326),
      accuracy_m real,
      usng text,
      landmark text,
      structure text not null default 'single_family' check (structure in ('single_family', 'manufactured', 'apartment_building', 'commercial', 'public', 'other')),
      degree text not null check (degree in ('no_damage', 'affected', 'minor', 'major', 'destroyed', 'cannot_tell', 'cant_reach')),
      observations jsonb not null default '{}'::jsonb,
      note text,
      report_id uuid references cg.report(id),
      duplicate_of uuid references cg.field_assessment(id),
      review_state text not null default 'new' check (review_state in ('new', 'accepted', 'rejected', 'superseded')),
      reviewed_by uuid,
      reviewed_at timestamptz,
      review_reason text,
      assessed_at timestamptz not null default now(),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid)
    )`.execute(db);
  await sql`create index field_assessment_parcel_idx on cg.field_assessment (tenant_id, event_id, parcel_id)`.execute(
    db,
  );
  await sql`create index field_assessment_review_idx on cg.field_assessment (tenant_id, review_state, assessed_at)`.execute(
    db,
  );
  await sql`create index field_assessment_geom_idx on cg.field_assessment using gist (geom)`.execute(
    db,
  );
  await sql`create trigger field_assessment_touch before update on cg.field_assessment for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.field_assessment')`.execute(db);
  await sql`drop policy tenant_delete on cg.field_assessment`.execute(db);
  // The board and the reviewers follow new assessments (ADR-0022, 0036).
  await sql`create trigger field_assessment_feed after insert or update on cg.field_assessment
            for each row execute function cg.feed_change('event', 'event_id')`.execute(db);

  // DSP-11: assessments land in the ICS 214 activity log like every other field fact.
  await sql`alter table cg.activity_entry drop constraint activity_entry_kind_check`.execute(db);
  await sql`alter table cg.activity_entry add constraint activity_entry_kind_check check (kind in ('check_in', 'check_out', 'assigned', 'dispatched', 'acknowledged', 'en_route', 'on_scene', 'cleared', 'released', 'status', 'message', 'alert', 'service', 'hazard', 'note', 'assessment'))`.execute(
    db,
  );

  // FLD-07: a field photo points at the record it documents.
  await sql`alter table cg.photo add column field_record_type text check (field_record_type in ('field_assessment', 'hazard', 'mission', 'need', 'search_mark', 'placard', 'site'))`.execute(
    db,
  );
  await sql`alter table cg.photo add column field_record_id uuid`.execute(db);
  await sql`create index photo_field_record_idx on cg.photo (tenant_id, field_record_type, field_record_id) where field_record_id is not null`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from cg.activity_entry where kind = 'assessment'`.execute(db);
  await sql`alter table cg.activity_entry drop constraint activity_entry_kind_check`.execute(db);
  await sql`alter table cg.activity_entry add constraint activity_entry_kind_check check (kind in ('check_in', 'check_out', 'assigned', 'dispatched', 'acknowledged', 'en_route', 'on_scene', 'cleared', 'released', 'status', 'message', 'alert', 'service', 'hazard', 'note'))`.execute(
    db,
  );
  await sql`drop index if exists cg.photo_field_record_idx`.execute(db);
  await sql`alter table cg.photo drop column if exists field_record_id`.execute(db);
  await sql`alter table cg.photo drop column if exists field_record_type`.execute(db);
  await sql`drop table if exists cg.field_assessment cascade`.execute(db);
}
