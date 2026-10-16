/**
 * 0082 documents a survivor chooses to share (FL-09): a lease, an ID or an
 * insurance letter, photographed with their consent straight into their
 * record. Each row keeps what they agreed to (the words shown or read, in
 * their language, and whether they said or tapped yes), who took it and
 * when, and the photo. The photo is a `cg.photo` row linked as field record
 * type `shared_document`, never by `report_id`, so a document never appears
 * among the report's damage photos or in a FEMA package. Retention category
 * `photos`.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

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
];
const list = (types: string[]) => types.map((t) => `'${t}'`).join(', ');

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.shared_document (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      client_uuid uuid not null,
      kind text not null check (kind in ('lease', 'id', 'insurance', 'other')),
      consent_method text not null check (consent_method in ('spoken', 'tapped')),
      consent_language text not null,
      consent_text text not null,
      consented_at timestamptz not null default now(),
      taken_by uuid not null,
      photo_id uuid references cg.photo(id),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid)
    )`.execute(db);
  await sql`create index shared_document_report_idx
    on cg.shared_document (tenant_id, report_id)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.shared_document')`.execute(db);
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${list([...RECORD_TYPES, 'shared_document'])}))`,
    )
    .execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.photo drop constraint photo_field_record_type_check`.execute(db);
  await sql`alter table cg.photo no force row level security`.execute(db);
  await sql`update cg.photo set field_record_type = null, field_record_id = null
    where field_record_type = 'shared_document'`.execute(db);
  await sql`alter table cg.photo force row level security`.execute(db);
  await sql
    .raw(
      `alter table cg.photo add constraint photo_field_record_type_check check (field_record_type in (${list(RECORD_TYPES)}))`,
    )
    .execute(db);
  await sql`drop table if exists cg.shared_document`.execute(db);
  await loadDictionary(db);
}
