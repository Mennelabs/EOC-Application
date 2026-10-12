/**
 * 0013 damage reports, versions, review decisions, correction requests and
 * photos (layer-2 plan §2; BRD:FR-10.*, FR-12.*, DCL:DEC-02/03/04, RULE-08/09,
 * CON-10, PHO-04–PHO-08, AC-10B/C, AC-12C).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.report (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      reference_code text not null,
      execution_id uuid not null,
      event_id uuid references cg.event(id),
      graph_key text not null,
      graph_version integer not null,
      channel_of_origin text not null check (channel_of_origin in ('web', 'sms', 'voice', 'assisted')),
      channels_used text[] not null default '{}',
      relationship text not null check (relationship in ('own_home', 'helper', 'witness', 'organization')),
      reporter_party_id uuid references cg.party(id),
      subject_party_id uuid references cg.party(id),
      helper_party_id uuid references cg.party(id),
      location_id uuid references cg.location(id),
      answers jsonb not null default '{}'::jsonb,
      answers_enc bytea,
      original_text_enc bytea,
      original_lang text,
      translation_enc bytea,
      translation_provider text,
      extraction_id uuid,
      review_state text not null default 'submitted'
        check (review_state in ('submitted', 'under_review', 'needs_information', 'approved', 'rejected', 'duplicate', 'superseded')),
      verification_level text not null default 'self_reported'
        check (verification_level in ('self_reported', 'desktop_verified', 'field_verified', 'cannot_verify')),
      fema_degree text check (fema_degree in ('affected', 'minor', 'major', 'destroyed', 'no_damage', 'cannot_tell')),
      fema_degree_set_by uuid,
      fema_degree_set_at timestamptz,
      is_primary_residence boolean,
      pre_existing_damage boolean,
      duplicate_of uuid references cg.report(id),
      supersedes uuid references cg.report(id),
      need_signals jsonb not null default '{}'::jsonb,
      danger_flag boolean not null default false,
      told_to_call_911_at timestamptz,
      submitted_at timestamptz not null default now(),
      withdrawn_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, reference_code),
      unique (execution_id)
    )`.execute(db);
  await sql`create index report_queue_idx on cg.report (tenant_id, event_id, review_state, submitted_at)`.execute(
    db,
  );
  await sql`create index report_location_idx on cg.report (location_id)`.execute(db);
  await sql`create trigger report_touch before update on cg.report for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.report')`.execute(db);
  await sql`alter table cg.reference_code add constraint reference_code_report_fk foreign key (report_id) references cg.report(id)`.execute(
    db,
  );

  // Immutable snapshots: every change by resident, reviewer or system (FR-10.06, RES-02, AC-10B, AC-12C).
  await sql`
    create table cg.report_version (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      report_version integer not null,
      snapshot jsonb not null,
      changed_by_kind text not null check (changed_by_kind in ('resident', 'reviewer', 'system')),
      changed_by uuid,
      reason text,
      created_at timestamptz not null default now(),
      unique (report_id, report_version)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.report_version')`.execute(db);
  await sql`drop policy tenant_update on cg.report_version`.execute(db);
  await sql`drop policy tenant_delete on cg.report_version`.execute(db);

  // Reviewer decisions, append-only (FR-12.02, FR-12.04, AC-12A/B).
  await sql`
    create table cg.review_decision (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      report_version integer not null,
      reviewer_account_id uuid not null,
      decision text not null check (decision in ('approve', 'reject', 'needs_information', 'duplicate', 'supersede', 'reopen', 'verify', 'set_degree')),
      reason text not null,
      evidence_refs jsonb not null default '[]'::jsonb,
      ai_suggestion_id uuid,
      agreed_with_ai boolean,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index review_decision_report_idx on cg.review_decision (report_id, created_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.review_decision')`.execute(db);
  await sql`drop policy tenant_update on cg.review_decision`.execute(db);
  await sql`drop policy tenant_delete on cg.review_decision`.execute(db);

  await sql`
    create table cg.correction_request (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      questions jsonb not null,
      message text,
      sent_via text check (sent_via in ('sms', 'email', 'voice', 'none')),
      requested_by uuid not null,
      requested_at timestamptz not null default now(),
      answered_at timestamptz,
      resolution text check (resolution in ('answered', 'withdrawn', 'expired')),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create trigger correction_request_touch before update on cg.correction_request for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.correction_request')`.execute(db);

  // Photos: originals restricted, derivatives only once EXIF is stripped (PHO-06/07/08, AC-10C).
  await sql`
    create table cg.photo (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      execution_id uuid not null,
      report_id uuid references cg.report(id),
      shot text not null default 'other',
      source text not null default 'web' check (source in ('web', 'mms', 'assisted', 'field')),
      object_key_original text not null,
      derivative_keys jsonb not null default '{}'::jsonb,
      exif_stripped boolean not null default false,
      blur_status text not null default 'pending' check (blur_status in ('pending', 'applied', 'skipped_no_detector', 'failed')),
      status text not null default 'uploading' check (status in ('uploading', 'uploaded', 'processed', 'failed', 'rejected')),
      content_type text,
      width integer check (width >= 0),
      height integer check (height >= 0),
      bytes bigint check (bytes >= 0),
      sha256 bytea,
      suggested_taken_at timestamptz,
      suggested_geom geometry(Point, 4326),
      uploaded_at timestamptz,
      processed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index photo_execution_idx on cg.photo (execution_id)`.execute(db);
  await sql`create index photo_report_idx on cg.photo (report_id)`.execute(db);
  await sql`create index photo_sha_idx on cg.photo (tenant_id, sha256) where sha256 is not null`.execute(
    db,
  );
  await sql`create trigger photo_touch before update on cg.photo for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.photo')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.photo cascade`.execute(db);
  await sql`drop table if exists cg.correction_request cascade`.execute(db);
  await sql`drop table if exists cg.review_decision cascade`.execute(db);
  await sql`drop table if exists cg.report_version cascade`.execute(db);
  await sql`alter table cg.reference_code drop constraint if exists reference_code_report_fk`.execute(
    db,
  );
  await sql`drop table if exists cg.report cascade`.execute(db);
}
