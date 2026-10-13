/**
 * 0028 field roster (layer-4 plan §2, task A; PER-01, PER-02, BRD:FR-05.01–
 * 05.06, AC-05A, DSP-02, DSP-07, FLD-02, FLD-03, FL-17, FL:FR-13): recorded
 * credentials per person (never inferred), the personnel columns the field
 * needs (hours limit, home agency, badge photo), teams and units with their
 * members over time, team status as confirmed and suggested facts kept apart
 * (RULE-03), check-ins and check-outs with the credentials in force at the
 * time, and registered app installs with remote wipe. The event gets its
 * check-in code. Every column is in the dictionary (SEC-11); the roster keeps
 * its own retention category because volunteer hours back FEMA Public
 * Assistance claims (FL-17, SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

const RETENTION_ROWS = `
        (p_tenant, 'records', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'photos', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'free_text', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'audit', interval '7 years', 'duration', 'SEC-13 default; cannot be shortened', p_actor),
        (p_tenant, 'position_trail', interval '30 days', 'duration', 'DSP-08', p_actor),
        (p_tenant, 'command_conversation', interval '30 days', 'duration', 'Section 30.2', p_actor),
        (p_tenant, 'scribe_audio', null, 'on_confirm', 'FL-04: deleted once the note is confirmed', p_actor),
        (p_tenant, 'cji', null, 'external', 'SEC-12: CJIS and state records rules in the enclave', p_actor),
        (p_tenant, 'drafts', interval '7 days', 'duration', 'INT-20: paused reports', p_actor),
        (p_tenant, 'otp', interval '1 day', 'duration', 'SEC-09: one-time codes', p_actor),
        (p_tenant, 'sessions', interval '90 days', 'duration', 'CHN-03/05: SMS and voice sessions', p_actor),
        (p_tenant, 'abuse_signals', interval '90 days', 'duration', 'SEC-17: rate-limit and risk evidence', p_actor),
        (p_tenant, 'sharing', interval '7 years', 'duration', 'NED-04/05: grants and recall notices follow the report', p_actor),
        (p_tenant, 'referrals', interval '7 years', 'duration', 'FL-10, F17: referrals and communication attempts', p_actor),
        (p_tenant, 'contacts', interval '3 years', 'duration', 'F17, CNT-01: re-verified each season', p_actor),
        (p_tenant, 'publications', interval '7 years', 'duration', 'PUB-06: what was published, where and when', p_actor),
        (p_tenant, 'site_confirmations', interval '1 year', 'duration', 'PUB-03: confirmation history', p_actor),
        (p_tenant, 'reminders', interval '1 year', 'duration', 'F09, REM-01: reminders and notices sent', p_actor)`;

export function retentionFunction(extraRows: string): string {
  return `
    create or replace function cg.seed_retention_defaults(p_tenant uuid, p_actor uuid) returns void
    language sql as $$
      insert into cg.retention_policy (tenant_id, data_category, keep_for, rule, note, created_by)
      values${RETENTION_ROWS}${extraRows}
      on conflict do nothing
    $$`;
}

export const FIELD_RECORDS_ROW = `,\n        (p_tenant, 'field_records', interval '7 years', 'duration', 'FL-17, DSP-11: roster, check-ins and hours back FEMA Public Assistance claims', p_actor)`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // A database that ran 0027 before layer 4 holds the notice ledger as cg.reminder; the name
  // belongs to the F09 model from 0032 on, so the ledger takes its final name here first.
  await sql`
    do $$ begin
      if exists (select 1 from information_schema.columns
                 where table_schema = 'cg' and table_name = 'reminder' and column_name = 'cycle_key') then
        alter table cg.reminder rename to notice_log;
        alter index cg.reminder_due_idx rename to notice_log_due_idx;
        alter table cg.notice_log rename constraint reminder_pkey to notice_log_pkey;
        alter table cg.notice_log rename constraint reminder_tenant_id_kind_subject_id_cycle_key_key
          to notice_log_tenant_id_kind_subject_id_cycle_key_key;
      end if;
    end $$`.execute(db);

  // Personnel: the field needs an hours limit (PER-02), the home agency when it is a
  // tenant of its own (DSP-09) and a badge photo reference (FR-13.01, layer-4 B).
  await sql`
    alter table cg.personnel
      add column hours_limit integer check (hours_limit between 1 and 24),
      add column home_tenant_id uuid references cg.tenant(id),
      add column photo_key text,
      add column archived_at timestamptz,
      add column archived_reason text`.execute(db);
  await sql`create index personnel_home_idx on cg.personnel (tenant_id, home_tenant_id)`.execute(
    db,
  );

  // The event's check-in code: typed into the field app or carried by the QR at staging (FLD-03).
  await sql`alter table cg.event add column check_in_code text`.execute(db);
  await sql`create unique index event_check_in_code_idx on cg.event (tenant_id, upper(check_in_code)) where check_in_code is not null`.execute(
    db,
  );

  // Credentials are recorded, verified and expire; the system never infers one (PER-01, FR-05.06).
  await sql`
    create table cg.credential (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      personnel_id uuid not null references cg.personnel(id),
      kind text not null check (kind in ('damage_assessor', 'chainsaw', 'spanish_speaker', 'chaplain', 'ham_operator', 'medical', 'cert', 'driver_cdl', 'heavy_equipment', 'shelter_management', 'food_safety', 'child_safeguarding', 'mental_health_first_aid', 'background_check', 'other')),
      label text,
      issuer text,
      issued_at date,
      expires_at date,
      status text not null default 'recorded' check (status in ('recorded', 'verified', 'expired', 'revoked')),
      verified_by uuid,
      verified_at timestamptz,
      evidence_key text,
      note text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index credential_person_idx on cg.credential (tenant_id, personnel_id, status)`.execute(
    db,
  );
  await sql`create index credential_kind_idx on cg.credential (tenant_id, kind, status)`.execute(
    db,
  );
  await sql`create index credential_expiry_idx on cg.credential (tenant_id, expires_at) where expires_at is not null`.execute(
    db,
  );
  await sql`create trigger credential_touch before update on cg.credential for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.credential')`.execute(db);
  // Credentials are revoked, never deleted: an assignment made on one must stay explainable (FR-05.05).
  await sql`drop policy tenant_delete on cg.credential`.execute(db);

  // Teams and units (DSP-02, FR-06.08, FL:FR-13). The agency is a tenant when the
  // organization runs its own accounts (DSP-09), else a name.
  await sql`
    create table cg.team (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid references cg.event(id),
      key text not null,
      name text not null,
      kind text not null default 'team' check (kind in ('team', 'unit', 'canteen', 'crew', 'strike_team', 'net')),
      agency_tenant_id uuid references cg.tenant(id),
      agency text,
      callsign text,
      lead_personnel_id uuid references cg.personnel(id),
      skills text[] not null default '{}',
      equipment text[] not null default '{}',
      capacity integer check (capacity >= 0),
      check_in_interval_minutes integer not null default 60 check (check_in_interval_minutes between 5 and 480),
      status text not null default 'active' check (status in ('active', 'stood_down', 'archived')),
      notes text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, key)
    )`.execute(db);
  await sql`create index team_agency_idx on cg.team (tenant_id, agency_tenant_id, status)`.execute(
    db,
  );
  await sql`create index team_event_idx on cg.team (event_id)`.execute(db);
  await sql`create trigger team_touch before update on cg.team for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.team')`.execute(db);
  await sql`drop policy tenant_delete on cg.team`.execute(db);

  // Membership over time: a person leaves a team by closing the row, so hours and the
  // ICS 214 log keep who was on which team when (DSP-11, FL-17).
  await sql`
    create table cg.team_member (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      team_id uuid not null references cg.team(id),
      personnel_id uuid not null references cg.personnel(id),
      role text not null default 'member' check (role in ('lead', 'member', 'driver', 'operator', 'medic')),
      joined_at timestamptz not null default now(),
      left_at timestamptz,
      left_reason text,
      created_by uuid,
      check (left_at is null or left_at >= joined_at)
    )`.execute(db);
  await sql`create unique index team_member_current_idx on cg.team_member (team_id, personnel_id) where left_at is null`.execute(
    db,
  );
  await sql`create index team_member_person_idx on cg.team_member (tenant_id, personnel_id, left_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.team_member')`.execute(db);
  await sql`drop policy tenant_delete on cg.team_member`.execute(db);

  // Team status as facts (DSP-01, DSP-05, RULE-03): a confirmed row is what the team or
  // the board set; a suggested row is what location or a timer proposed, kept apart
  // until confirmed. The latest confirmed row is the current status.
  await sql`
    create table cg.team_status (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      team_id uuid not null references cg.team(id),
      status text not null check (status in ('available', 'en_route', 'on_task', 'break', 'out_of_service', 'overdue')),
      fact text not null default 'confirmed' check (fact in ('confirmed', 'suggested')),
      source text not null check (source in ('app', 'console', 'net_control', 'timer', 'location', 'seed')),
      set_by_account_id uuid,
      check_in_id uuid,
      note text,
      detail jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index team_status_latest_idx on cg.team_status (team_id, fact, created_at desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.team_status')`.execute(db);
  await sql`drop policy tenant_update on cg.team_status`.execute(db);
  await sql`drop policy tenant_delete on cg.team_status`.execute(db);

  // Registered app installs (FLD-02): a personal phone shares only the app's data; wipe
  // is requested by an administrator and confirmed by the device.
  await sql`
    create table cg.field_device (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      account_id uuid not null references cg.account(id),
      install_id text not null,
      platform text not null check (platform in ('ios', 'android', 'web')),
      managed boolean not null default false,
      model text,
      app_version text,
      status text not null default 'active' check (status in ('active', 'wipe_requested', 'wiped', 'revoked')),
      registered_at timestamptz not null default now(),
      last_contact_at timestamptz,
      wipe_requested_at timestamptz,
      wipe_requested_by uuid,
      wipe_reason text,
      wipe_confirmed_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, install_id)
    )`.execute(db);
  await sql`create index field_device_account_idx on cg.field_device (tenant_id, account_id, status)`.execute(
    db,
  );
  await sql`create trigger field_device_touch before update on cg.field_device for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.field_device')`.execute(db);

  // Check-in and check-out (FLD-03): who, for which event, on which team and agency,
  // how, with the credentials in force at the time; hours come from the row (FL-17).
  await sql`
    create table cg.check_in (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      personnel_id uuid not null references cg.personnel(id),
      event_id uuid not null references cg.event(id),
      team_id uuid references cg.team(id),
      agency_tenant_id uuid references cg.tenant(id),
      method text not null check (method in ('qr', 'event_code', 'net_control', 'console')),
      credentials_snapshot jsonb not null default '[]'::jsonb,
      device_id uuid references cg.field_device(id),
      location_sharing boolean not null default true,
      started_at timestamptz not null default now(),
      ended_at timestamptz,
      ended_by uuid,
      end_reason text check (end_reason in ('checked_out', 'shift_end', 'coordinator', 'timeout', 'wipe')),
      hours numeric(6, 2) generated always as (round(extract(epoch from (ended_at - started_at))::numeric / 3600, 2)) stored,
      created_by uuid,
      check (ended_at is null or ended_at >= started_at)
    )`.execute(db);
  await sql`create unique index check_in_open_idx on cg.check_in (personnel_id) where ended_at is null`.execute(
    db,
  );
  await sql`create index check_in_event_idx on cg.check_in (tenant_id, event_id, ended_at)`.execute(
    db,
  );
  await sql`create index check_in_team_idx on cg.check_in (team_id, ended_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.check_in')`.execute(db);
  await sql`drop policy tenant_delete on cg.check_in`.execute(db);
  await sql`alter table cg.team_status add constraint team_status_check_in_fk foreign key (check_in_id) references cg.check_in(id)`.execute(
    db,
  );

  await sql.raw(retentionFunction(FIELD_RECORDS_ROW)).execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.check_in cascade`.execute(db);
  await sql`drop table if exists cg.field_device cascade`.execute(db);
  await sql`drop table if exists cg.team_status cascade`.execute(db);
  await sql`drop table if exists cg.team_member cascade`.execute(db);
  await sql`drop table if exists cg.team cascade`.execute(db);
  await sql`drop table if exists cg.credential cascade`.execute(db);
  await sql`alter table cg.event drop column if exists check_in_code`.execute(db);
  await sql`
    alter table cg.personnel
      drop column if exists hours_limit,
      drop column if exists home_tenant_id,
      drop column if exists photo_key,
      drop column if exists archived_at,
      drop column if exists archived_reason`.execute(db);
  await sql`delete from cg.retention_policy where data_category = 'field_records' and note like '%:%'`.execute(
    db,
  );
  await sql.raw(retentionFunction('')).execute(db);
}
