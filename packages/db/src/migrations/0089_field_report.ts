/**
 * 0089 quick reports from the field that are not hazards (FLD-11): what a
 * worker saw at a site (open, limited, full, closed or damaged) and a
 * resource they came across (water, food, fuel, a pharmacy or store that is
 * open, power, equipment), each as a pin, a photo and a category. A report is
 * an observation, never the site's status of record: only the site's
 * operators confirm that (`site.confirm`). Dispatch marks a report noted.
 * Records are field records (SEC-13, the `field_records` category, deleted
 * by the worker role only once their event has closed for the period), and
 * a photo links to one as field record type `field_report` (FLD-07).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

/** The photo record types before this migration (0082). */
const RECORD_TYPES = [
  'field_assessment',
  'hazard',
  'mission',
  'need',
  'search_mark',
  'placard',
  'site',
  'pet_intake',
  'site_walkthrough',
  'debris_ticket',
  'inspection',
  'road_status',
  'canvass_visit',
  'pa_site',
  'shared_document',
];
const list = (types: string[]) => types.map((t) => `'${t}'`).join(', ');

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.field_report (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      client_uuid uuid not null,
      category text not null check (category in ('site_status', 'resource_seen')),
      site_id uuid references cg.site(id),
      site_status text check (site_status in ('open', 'limited', 'full', 'closed', 'damaged')),
      resource_kind text check (resource_kind in ('water', 'food', 'fuel', 'pharmacy', 'store', 'power', 'equipment', 'other')),
      place text,
      note text,
      geom geometry(Point, 4326),
      accuracy_m double precision,
      reported_by uuid,
      reported_personnel_id uuid references cg.personnel(id),
      reported_at timestamptz not null default now(),
      noted_at timestamptz,
      noted_by uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid),
      check ((category = 'site_status') = (site_status is not null)),
      check ((category = 'resource_seen') = (resource_kind is not null)),
      check (category = 'site_status' or site_id is null),
      check ((noted_at is null) = (noted_by is null))
    )`.execute(db);
  await sql`create index field_report_event_idx
    on cg.field_report (tenant_id, event_id, reported_at desc)`.execute(db);
  await sql`create trigger field_report_touch before update on cg.field_report for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.field_report')`.execute(db);
  // Reports are noted, never deleted by the application; only the retention sweep removes them.
  await sql`drop policy tenant_delete on cg.field_report`.execute(db);
  await sql`create policy retention_delete on cg.field_report for delete using (cg.is_system())`.execute(
    db,
  );
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${list([...RECORD_TYPES, 'field_report'])}))`,
    )
    .execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql`alter table cg.photo no force row level security`.execute(db);
  await sql`update cg.photo set field_record_type = null, field_record_id = null
    where field_record_type = 'field_report'`.execute(db);
  await sql`alter table cg.photo force row level security`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${list(RECORD_TYPES)}))`,
    )
    .execute(db);
  await sql`drop table if exists cg.field_report`.execute(db);
  await loadDictionary(db);
}
