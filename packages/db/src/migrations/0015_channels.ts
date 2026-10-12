/**
 * 0015 channels (layer-2 plan §2): paused drafts (INT-20), one-time codes for
 * report lookup (SEC-09, RES-01), SMS and voice sessions (CHN-03/05), every
 * outbound message with provider evidence (BRD:FR-17.05) and abuse signals
 * (SEC-17).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.draft (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      resume_code_hash bytea not null,
      execution_id uuid not null,
      payload_enc bytea not null,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create unique index draft_code_idx on cg.draft (tenant_id, resume_code_hash)`.execute(
    db,
  );
  await sql`create index draft_expiry_idx on cg.draft (expires_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.draft')`.execute(db);

  await sql`
    create table cg.otp_challenge (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      contact_bidx bytea not null,
      channel text not null check (channel in ('sms', 'email')),
      code_hash bytea not null,
      attempts integer not null default 0,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index otp_report_idx on cg.otp_challenge (report_id, created_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.otp_challenge')`.execute(db);

  await sql`
    create table cg.intake_session (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      channel text not null check (channel in ('sms', 'voice')),
      phone_bidx bytea not null,
      phone_enc bytea not null,
      event_id uuid references cg.event(id),
      language text not null default 'en',
      graph_key text not null,
      graph_version integer not null,
      cursor text,
      answers_enc bytea,
      execution_id uuid not null,
      state text not null default 'active' check (state in ('active', 'paused', 'submitted', 'stopped', 'expired')),
      opt_out boolean not null default false,
      last_inbound_at timestamptz not null default now(),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create unique index intake_session_active_idx on cg.intake_session (tenant_id, phone_bidx, channel) where state = 'active'`.execute(
    db,
  );
  await sql`create trigger intake_session_touch before update on cg.intake_session for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.intake_session')`.execute(db);

  await sql`
    create table cg.message (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      channel text not null check (channel in ('sms', 'mms', 'voice', 'email')),
      to_bidx bytea,
      to_enc bytea not null,
      template text not null,
      body_enc bytea not null,
      state text not null default 'queued' check (state in ('queued', 'sent', 'delivered', 'acknowledged', 'failed')),
      provider text,
      provider_message_id text,
      provider_evidence jsonb not null default '{}'::jsonb,
      error text,
      report_id uuid references cg.report(id),
      party_id uuid references cg.party(id),
      queued_at timestamptz not null default now(),
      sent_at timestamptz,
      delivered_at timestamptz,
      failed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index message_report_idx on cg.message (report_id)`.execute(db);
  await sql`create index message_provider_idx on cg.message (provider_message_id) where provider_message_id is not null`.execute(
    db,
  );
  await sql`create trigger message_touch before update on cg.message for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.message')`.execute(db);

  await sql`
    create table cg.abuse_signal (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      kind text not null,
      subject_hash bytea not null,
      execution_id uuid,
      score integer not null default 0,
      decision text not null check (decision in ('allow', 'verify', 'deny')),
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index abuse_signal_subject_idx on cg.abuse_signal (tenant_id, subject_hash, created_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.abuse_signal')`.execute(db);
  await sql`drop policy tenant_update on cg.abuse_signal`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.abuse_signal cascade`.execute(db);
  await sql`drop table if exists cg.message cascade`.execute(db);
  await sql`drop table if exists cg.intake_session cascade`.execute(db);
  await sql`drop table if exists cg.otp_challenge cascade`.execute(db);
  await sql`drop table if exists cg.draft cascade`.execute(db);
}
