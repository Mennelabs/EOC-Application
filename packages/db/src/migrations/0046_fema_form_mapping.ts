/**
 * 0046 FEMA form mappings (layer-6 task F; DCL:DEC-12, DEC-15): a county's
 * own versions of the mapping from a FEMA form's fields to the platform's
 * data elements. Version 1 of each form ships with the platform
 * (packages/reporting fema/shipped.ts) and is in force until the county
 * activates a later version here; a draft is edited, then activated with a
 * confirmed reason, which retires the version it replaces. At most one
 * active version per form. Every column is in the dictionary; RLS.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export const MAPPED_FORMS = [
  'ia_street_sheet',
  'ia_survey_single_family',
  'ia_survey_multi_family',
  'home_insurance_matrix',
  'ia_summary_sheet',
  'ia_tick_sheet',
  'pa_site_sheet',
  'pa_cost_survey',
  'form_010_0_13',
  'pda_gis_layer',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `create table cg.fema_form_mapping (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      form text not null check (form in (${MAPPED_FORMS.map((f) => `'${f}'`).join(', ')})),
      fema_form_version text not null check (char_length(fema_form_version) between 1 and 200),
      mapping_version integer not null check (mapping_version > 1),
      status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
      scope jsonb not null default '{}'::jsonb,
      fields jsonb not null,
      source_document text check (char_length(source_document) <= 500),
      note text check (char_length(note) <= 2000),
      activated_by uuid,
      activated_at timestamptz,
      activation_reason text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, form, mapping_version),
      check ((status = 'draft') = (activated_at is null))
    )`,
    )
    .execute(db);
  await sql`create unique index fema_form_mapping_one_active on cg.fema_form_mapping (tenant_id, form)
            where status = 'active'`.execute(db);
  await sql`create trigger fema_form_mapping_touch before update on cg.fema_form_mapping for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.fema_form_mapping')`.execute(db);
  await sql`drop policy tenant_delete on cg.fema_form_mapping`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.fema_form_mapping`.execute(db);
  await loadDictionary(db);
}
