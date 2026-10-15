/**
 * 0071 the damage severity suggestion (layer-7 task I; PHO-09, PHO-10,
 * PHO-11, PHO-12 and PHO-13 as decided 2026-10-15, DCL:DEC-02, AIG-01). One
 * row each time the classifier looks at a report's photos: the suggested
 * degree or "cannot tell", its confidence, the visible features it rests on,
 * the photos it saw, and the provider, model and prompt version, so a
 * validated classifier can replace the model without losing the record. Only
 * reviewers ever see it; a credentialed reviewer sets the degree, and their
 * decision records whether they agreed (review_decision.ai_suggestion_id and
 * agreed_with_ai, which exist since 0013). The register row for
 * photo.severity stays as it is: off until an administrator enables it.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.damage_suggestion (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      degree text not null check (degree in ('affected', 'minor', 'major', 'destroyed', 'cannot_tell')),
      confidence numeric(4, 3) not null check (confidence between 0 and 1),
      visible_features text[] not null default '{}',
      photo_ids uuid[] not null,
      provider text not null,
      model text not null,
      template_version text,
      ai_output_id uuid,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index damage_suggestion_report on cg.damage_suggestion (tenant_id, report_id, created_at desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.damage_suggestion')`.execute(db);
  await sql`drop policy tenant_update on cg.damage_suggestion`.execute(db);
  await sql`drop policy tenant_delete on cg.damage_suggestion`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.damage_suggestion`.execute(db);
}
