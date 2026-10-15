/**
 * 0055 AI output records and health alerts (layer-7 task A; AIG-01, AI-03,
 * AIG-09 as decided 2026-10-15, AI-10, CMD-37, NFR-10).
 *
 * `cg.ai_output`: one row per AI call: feature, provider, the model that
 * answered, the prompt template version, language, latency, outcome, and
 * what a person did with it (accepted, edited or rejected), with the record
 * it concerns. Never the prompt or the reply: those stay in the feature's
 * own encrypted columns under their retention category.
 *
 * `cg.ai_health_alert`: a feature whose outputs people correct or reject too
 * often in a language, or whose calls fail too often, raises an alert to the
 * tenant's administrators. The feature keeps running (Adam's decision, a
 * deviation from AIG-09's switch-off); a failing call still falls back to the
 * manual path at once (AI-10).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.ai_output (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      feature text not null,
      provider text not null,
      model text not null,
      template_version text,
      language text,
      outcome text not null
        check (outcome in ('ok', 'filtered', 'invalid', 'refused', 'timeout', 'error')),
      latency_ms integer not null check (latency_ms >= 0),
      execution_id uuid,
      target_type text,
      target_id uuid,
      human_action text check (human_action in ('accepted', 'edited', 'rejected')),
      acted_by uuid,
      acted_at timestamptz,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index ai_output_health_idx
    on cg.ai_output (tenant_id, feature, language, created_at desc)`.execute(db);
  await sql`create index ai_output_target_idx on cg.ai_output (target_type, target_id)
    where target_id is not null`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.ai_output')`.execute(db);
  // AIG-01: the record of AI use is kept with the records; nobody deletes a row.
  await sql`drop policy tenant_delete on cg.ai_output`.execute(db);

  await sql`
    create table cg.ai_health_alert (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      feature text not null,
      language text not null default '',
      kind text not null check (kind in ('corrections', 'failures')),
      window_size integer not null,
      counted integer not null,
      flagged integer not null,
      rate numeric(5, 4) not null,
      threshold numeric(5, 4) not null,
      raised_at timestamptz not null default now(),
      acknowledged_by uuid,
      acknowledged_at timestamptz,
      cleared_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create unique index ai_health_alert_open_idx
    on cg.ai_health_alert (tenant_id, feature, language, kind) where cleared_at is null`.execute(
    db,
  );
  await sql`create trigger ai_health_alert_touch before update on cg.ai_health_alert
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.ai_health_alert')`.execute(db);
  await sql`drop policy tenant_delete on cg.ai_health_alert`.execute(db);

  // The notice to administrators goes through the notice ledger (one per alert).
  await sql`alter table cg.notice_log drop constraint notice_log_kind_check`.execute(db);
  await sql`alter table cg.notice_log add constraint notice_log_kind_check check (kind in (
    'site_reconfirm', 'site_hidden', 'resource_review', 'resource_link', 'resource_expired',
    'contact_reverify', 'publication', 'publication_withdrawn', 'ai_health'))`.execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_subject_kind_check`.execute(db);
  await sql`alter table cg.notice_log add constraint notice_log_subject_kind_check check (
    subject_kind in ('site', 'resource', 'partner_contact', 'publication', 'tenant', 'ai_health_alert'))`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from cg.notice_log where kind = 'ai_health'`.execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_kind_check`.execute(db);
  await sql`alter table cg.notice_log add constraint notice_log_kind_check check (kind in (
    'site_reconfirm', 'site_hidden', 'resource_review', 'resource_link', 'resource_expired',
    'contact_reverify', 'publication', 'publication_withdrawn'))`.execute(db);
  await sql`alter table cg.notice_log drop constraint notice_log_subject_kind_check`.execute(db);
  await sql`alter table cg.notice_log add constraint notice_log_subject_kind_check check (
    subject_kind in ('site', 'resource', 'partner_contact', 'publication', 'tenant'))`.execute(db);
  await sql`drop table if exists cg.ai_health_alert`.execute(db);
  await sql`drop table if exists cg.ai_output`.execute(db);
}
