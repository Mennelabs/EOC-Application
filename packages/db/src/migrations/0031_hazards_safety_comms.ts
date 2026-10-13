/**
 * 0031 hazards, field messages, safety alerts, net control and the logs
 * (layer-4 plan §2, task B; HAZ-01, BRD:FR-04.01–04.05, AC-04A/B/C, DSP-06,
 * DSP-07, DSP-10, DSP-11, FLD-16, FLD-17, FL:FR-17.05): hazards with reported,
 * confirmed, corrected and cleared kept apart and restricted details
 * encrypted; messages to a person, team, agency or area with per-recipient
 * receipts and the text fallback's message row; help-button and timer alerts
 * with the exact position; the ICS 309-style communications log; the ICS 214
 * activity entries and the significant events log. Every column is in the
 * dictionary (SEC-11); retention categories `safety` and `comms` (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';
import { FIELD_RECORDS_ROW, retentionFunction } from './0028_field_roster.ts';

export const SAFETY_COMMS_ROWS = `,\n        (p_tenant, 'safety', interval '7 years', 'duration', 'DSP-07, FLD-16: safety alerts and their handling', p_actor),\n        (p_tenant, 'comms', interval '7 years', 'duration', 'DSP-10, DSP-11: communications, activity and significant events logs (ICS 309, ICS 214)', p_actor)`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.hazard (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      mission_id uuid references cg.mission(id),
      kind text not null check (kind in ('downed_line', 'gas_leak', 'blocked_road', 'unsafe_structure', 'flooding', 'debris', 'weapons', 'hazmat', 'medical_emergency', 'mental_health_crisis', 'violence', 'child_or_elder_involved', 'language_barrier', 'utility_risk', 'weather', 'public_health', 'animal', 'missing_person_concern', 'other')),
      state text not null default 'reported' check (state in ('reported', 'confirmed', 'corrected', 'cleared')),
      severity text not null default 'caution' check (severity in ('info', 'caution', 'danger', 'critical')),
      summary text,
      restricted boolean not null default false,
      details_enc bytea,
      geom geometry(Geometry, 4326) check (geom is null or GeometryType(geom) in ('POINT', 'POLYGON', 'MULTIPOLYGON')),
      radius_m real check (radius_m >= 0),
      location_id uuid references cg.location(id),
      source text not null check (source in ('field', 'console', 'call', 'net_control', 'resident_report', 'ai_suggested')),
      ai_suggested boolean not null default false,
      accepted_by uuid,
      accepted_at timestamptz,
      reported_by uuid,
      reported_personnel_id uuid,
      reported_at timestamptz not null default now(),
      confirmed_at timestamptz,
      confirmed_by uuid,
      cleared_at timestamptz,
      cleared_by uuid,
      cleared_reason text,
      photo_id uuid references cg.photo(id),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index hazard_event_idx on cg.hazard (tenant_id, event_id, state, severity)`.execute(
    db,
  );
  await sql`create index hazard_mission_idx on cg.hazard (mission_id) where mission_id is not null`.execute(
    db,
  );
  await sql`create index hazard_geom_idx on cg.hazard using gist (geom)`.execute(db);
  await sql`create trigger hazard_touch before update on cg.hazard for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.hazard')`.execute(db);
  // Clearing keeps the original entry and its reason (AC-04B).
  await sql`drop policy tenant_delete on cg.hazard`.execute(db);

  await sql`
    create table cg.hazard_event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      hazard_id uuid not null references cg.hazard(id),
      kind text not null check (kind in ('reported', 'confirmed', 'corrected', 'cleared', 'accepted', 'reopened', 'warned')),
      from_state text,
      to_state text,
      actor_account_id uuid,
      actor_personnel_id uuid,
      reason text,
      detail jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index hazard_event_idx on cg.hazard_event (hazard_id, occurred_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.hazard_event')`.execute(db);
  await sql`drop policy tenant_update on cg.hazard_event`.execute(db);
  await sql`drop policy tenant_delete on cg.hazard_event`.execute(db);

  // Messages to the field (DSP-06): to a person, team, agency, event or a drawn area.
  await sql`
    create table cg.field_message (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      kind text not null default 'message' check (kind in ('message', 'assignment_notice', 'safety_warning', 'hazard_warning', 'broadcast', 'timer')),
      template text,
      body text not null,
      lang text not null default 'en',
      priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
      audience_kind text not null check (audience_kind in ('person', 'team', 'agency', 'area', 'event')),
      audience_personnel_id uuid references cg.personnel(id),
      audience_team_id uuid references cg.team(id),
      audience_tenant_id uuid references cg.tenant(id),
      audience_geom geometry(Geometry, 4326) check (audience_geom is null or GeometryType(audience_geom) in ('POLYGON', 'MULTIPOLYGON')),
      mission_id uuid references cg.mission(id),
      hazard_id uuid references cg.hazard(id),
      requires_ack boolean not null default false,
      sent_by uuid,
      sent_at timestamptz not null default now(),
      expires_at timestamptz,
      recipient_count integer not null default 0,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index field_message_event_idx on cg.field_message (tenant_id, event_id, sent_at desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.field_message')`.execute(db);
  await sql`drop policy tenant_delete on cg.field_message`.execute(db);

  // Per-recipient delivery, read and acknowledgement from the app; the text fallback
  // links the message row that carries the provider evidence (FR-17.05).
  await sql`
    create table cg.field_message_receipt (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      message_id uuid not null references cg.field_message(id),
      personnel_id uuid not null references cg.personnel(id),
      account_id uuid,
      device_id uuid references cg.field_device(id),
      channel text not null default 'app' check (channel in ('app', 'sms', 'radio', 'in_person')),
      sms_message_id uuid references cg.message(id),
      delivered_at timestamptz,
      read_at timestamptz,
      acknowledged_at timestamptz,
      created_at timestamptz not null default now(),
      unique (message_id, personnel_id)
    )`.execute(db);
  await sql`create index field_message_receipt_person_idx on cg.field_message_receipt (tenant_id, personnel_id, read_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.field_message_receipt')`.execute(db);
  await sql`drop policy tenant_delete on cg.field_message_receipt`.execute(db);

  // Safety alerts (FLD-16, DSP-07): the help button, a missed check-in, an unacknowledged
  // assignment, a team entering a hazard area. The position is exact whatever the
  // tenant's precision setting (plan §12.1); open until a person acknowledges.
  await sql`
    create table cg.safety_alert (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      kind text not null check (kind in ('help_button', 'missed_check_in', 'unacknowledged_assignment', 'hazard_entry', 'device_lost')),
      personnel_id uuid references cg.personnel(id),
      team_id uuid references cg.team(id),
      check_in_id uuid references cg.check_in(id),
      assignment_id uuid references cg.assignment(id),
      hazard_id uuid references cg.hazard(id),
      geom geometry(Point, 4326),
      accuracy_m real,
      position_at timestamptz,
      note text,
      state text not null default 'open' check (state in ('open', 'acknowledged', 'escalated', 'resolved', 'false_alarm')),
      raised_at timestamptz not null default now(),
      raised_by uuid,
      client_uuid uuid,
      acknowledged_at timestamptz,
      acknowledged_by uuid,
      escalated_at timestamptz,
      escalated_to_role text,
      resolved_at timestamptz,
      resolved_by uuid,
      resolution text,
      detail jsonb not null default '{}'::jsonb,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create unique index safety_alert_client_idx on cg.safety_alert (tenant_id, client_uuid) where client_uuid is not null`.execute(
    db,
  );
  await sql`create index safety_alert_open_idx on cg.safety_alert (tenant_id, event_id, state, raised_at desc)`.execute(
    db,
  );
  await sql`create trigger safety_alert_touch before update on cg.safety_alert for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.safety_alert')`.execute(db);
  await sql`drop policy tenant_delete on cg.safety_alert`.execute(db);

  // Net control (DSP-10, FLD-17): what was heard on the net, logged against the right team;
  // a position or status heard creates the position or status row and is linked here.
  await sql`
    create table cg.comms_log (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      net text not null,
      entry_at timestamptz not null default now(),
      from_station text,
      to_station text,
      team_id uuid references cg.team(id),
      kind text not null check (kind in ('status_heard', 'position_heard', 'message', 'check_in', 'check_out', 'traffic', 'net_open', 'net_close')),
      message text,
      operator_account_id uuid,
      team_status_id uuid references cg.team_status(id),
      position_id uuid,
      position_recorded_at timestamptz,
      check_in_id uuid references cg.check_in(id),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index comms_log_event_idx on cg.comms_log (tenant_id, event_id, net, entry_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.comms_log')`.execute(db);
  await sql`drop policy tenant_update on cg.comms_log`.execute(db);
  await sql`drop policy tenant_delete on cg.comms_log`.execute(db);

  // ICS 214 activity per person and team (DSP-11): fed by assignments, status changes,
  // messages, check-ins, alerts and service counters.
  await sql`
    create table cg.activity_entry (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      personnel_id uuid references cg.personnel(id),
      team_id uuid references cg.team(id),
      occurred_at timestamptz not null default now(),
      kind text not null check (kind in ('check_in', 'check_out', 'assigned', 'dispatched', 'acknowledged', 'en_route', 'on_scene', 'cleared', 'released', 'status', 'message', 'alert', 'service', 'hazard', 'note')),
      summary text not null,
      ref_kind text,
      ref_id uuid,
      actor_account_id uuid,
      created_at timestamptz not null default now(),
      check (personnel_id is not null or team_id is not null)
    )`.execute(db);
  await sql`create index activity_entry_team_idx on cg.activity_entry (tenant_id, team_id, occurred_at)`.execute(
    db,
  );
  await sql`create index activity_entry_person_idx on cg.activity_entry (tenant_id, personnel_id, occurred_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.activity_entry')`.execute(db);
  await sql`drop policy tenant_update on cg.activity_entry`.execute(db);
  await sql`drop policy tenant_delete on cg.activity_entry`.execute(db);

  await sql`
    create table cg.significant_event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      occurred_at timestamptz not null default now(),
      kind text not null check (kind in ('mission_opened', 'mission_closed', 'mission_priority', 'dispatch', 'arrival', 'hazard', 'safety_alert', 'site', 'message', 'check_in', 'briefing', 'note')),
      summary text not null,
      mission_id uuid references cg.mission(id),
      team_id uuid references cg.team(id),
      ref_kind text,
      ref_id uuid,
      actor_account_id uuid,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index significant_event_idx on cg.significant_event (tenant_id, event_id, occurred_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.significant_event')`.execute(db);
  await sql`drop policy tenant_update on cg.significant_event`.execute(db);
  await sql`drop policy tenant_delete on cg.significant_event`.execute(db);

  await sql.raw(retentionFunction(FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS)).execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.significant_event cascade`.execute(db);
  await sql`drop table if exists cg.activity_entry cascade`.execute(db);
  await sql`drop table if exists cg.comms_log cascade`.execute(db);
  await sql`drop table if exists cg.safety_alert cascade`.execute(db);
  await sql`drop table if exists cg.field_message_receipt cascade`.execute(db);
  await sql`drop table if exists cg.field_message cascade`.execute(db);
  await sql`drop table if exists cg.hazard_event cascade`.execute(db);
  await sql`drop table if exists cg.hazard cascade`.execute(db);
  await sql`delete from cg.retention_policy where data_category in ('safety', 'comms') and note like '%:%'`.execute(
    db,
  );
  await sql.raw(retentionFunction(FIELD_RECORDS_ROW)).execute(db);
}
