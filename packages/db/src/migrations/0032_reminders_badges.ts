/**
 * 0032 reminders (F09) and badges (layer-4 plan §2, task B; REM-01,
 * BRD:FR-09.01–09.06, AC-09A/B/C, BDG-01, BDG-02, BRD:FR-13.01–13.06,
 * AC-13A/B/C, RULE-11, FL:FR-03): with layer 3's send-once ledger under its
 * own name (`cg.notice_log`), `cg.reminder` takes the full F09 model, shared state
 * with owner, due time, snooze, acknowledgement apart from completion, and
 * completion only against a persisted update; badges hold an access label
 * apart from account permissions and a state per fact: generated, print
 * requested, print confirmed, print failed, handed out, revoked, expired,
 * replaced. Every column is in the dictionary (SEC-11); retention category
 * `badges` (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';
import { FIELD_RECORDS_ROW, retentionFunction } from './0028_field_roster.ts';
import { SAFETY_COMMS_ROWS } from './0031_hazards_safety_comms.ts';

export const BADGES_ROW = `,\n        (p_tenant, 'badges', interval '3 years', 'duration', 'BDG-02, FR-13.02: badge issuance and reprint history', p_actor)`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.reminder (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid references cg.event(id),
      kind text not null check (kind in ('call_back', 'site_reconfirm', 'renew_agreement', 'revisit', 'follow_up', 'check_in_timer', 'custom')),
      title text not null,
      note text,
      owner_account_id uuid,
      owner_team_id uuid references cg.team(id),
      mission_id uuid references cg.mission(id),
      subject_kind text,
      subject_id uuid,
      due_at timestamptz not null,
      recurrence text check (recurrence in ('daily', 'weekly')),
      recurrence_approved_by uuid,
      state text not null default 'active' check (state in ('active', 'overdue', 'acknowledged', 'completed', 'canceled')),
      snoozed_until timestamptz,
      acknowledged_at timestamptz,
      acknowledged_by uuid,
      completed_at timestamptz,
      completed_by uuid,
      completion_ref_kind text,
      completion_ref_id uuid,
      canceled_at timestamptz,
      canceled_by uuid,
      cancel_reason text,
      escalate_to_role text,
      escalate_after_minutes integer check (escalate_after_minutes > 0),
      escalated_at timestamptz,
      quiet_from time,
      quiet_to time,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (recurrence is null or recurrence_approved_by is not null),
      check (state <> 'completed' or completed_at is not null)
    )`.execute(db);
  await sql`create index reminder_owner_idx on cg.reminder (tenant_id, owner_account_id, state, due_at)`.execute(
    db,
  );
  await sql`create index reminder_due_idx on cg.reminder (tenant_id, state, due_at)`.execute(db);
  await sql`create index reminder_mission_idx on cg.reminder (mission_id) where mission_id is not null`.execute(
    db,
  );
  await sql`create trigger reminder_touch before update on cg.reminder for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.reminder')`.execute(db);
  await sql`drop policy tenant_delete on cg.reminder`.execute(db);

  await sql`
    create table cg.reminder_event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      reminder_id uuid not null references cg.reminder(id),
      kind text not null check (kind in ('created', 'snoozed', 'reset', 'acknowledged', 'completed', 'canceled', 'overdue', 'escalated', 'recurred')),
      actor_account_id uuid,
      detail jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index reminder_event_idx on cg.reminder_event (reminder_id, occurred_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.reminder_event')`.execute(db);
  await sql`drop policy tenant_update on cg.reminder_event`.execute(db);
  await sql`drop policy tenant_delete on cg.reminder_event`.execute(db);

  // Badges (FR-13.01–13.06, RULE-11): the access label is printed text, never a permission
  // (FR-13.03); the code is hashed, and the printed badge carries the same facts as text
  // (AC-13C); a database timestamp never equals a physical print (FR-13.06).
  await sql`
    create table cg.badge (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      personnel_id uuid not null references cg.personnel(id),
      event_id uuid references cg.event(id),
      template text not null default 'standard',
      display_name text not null,
      agency text,
      role_label text,
      access_label text,
      photo_key text,
      credentials_snapshot jsonb not null default '[]'::jsonb,
      valid_from timestamptz not null default now(),
      valid_to timestamptz not null,
      state text not null default 'generated' check (state in ('generated', 'print_requested', 'print_confirmed', 'print_failed', 'handed_out', 'revoked', 'expired', 'replaced')),
      code_hash bytea not null,
      replaces_badge_id uuid references cg.badge(id),
      print_requested_at timestamptz,
      print_confirmed_at timestamptz,
      print_confirmed_by uuid,
      print_failed_reason text,
      handed_out_at timestamptz,
      revoked_at timestamptz,
      revoked_by uuid,
      revoke_reason text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, code_hash),
      check (valid_to > valid_from)
    )`.execute(db);
  await sql`create index badge_person_idx on cg.badge (tenant_id, personnel_id, state)`.execute(db);
  await sql`create trigger badge_touch before update on cg.badge for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.badge')`.execute(db);
  await sql`drop policy tenant_delete on cg.badge`.execute(db);

  await sql`
    create table cg.badge_event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      badge_id uuid not null references cg.badge(id),
      kind text not null check (kind in ('generated', 'print_requested', 'print_confirmed', 'print_failed', 'handed_out', 'revoked', 'expired', 'replaced', 'verified')),
      actor_account_id uuid,
      detail jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index badge_event_idx on cg.badge_event (badge_id, occurred_at)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.badge_event')`.execute(db);
  await sql`drop policy tenant_update on cg.badge_event`.execute(db);
  await sql`drop policy tenant_delete on cg.badge_event`.execute(db);

  await sql.raw(retentionFunction(FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS + BADGES_ROW)).execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.badge_event cascade`.execute(db);
  await sql`drop table if exists cg.badge cascade`.execute(db);
  await sql`drop table if exists cg.reminder_event cascade`.execute(db);
  await sql`drop table if exists cg.reminder cascade`.execute(db);
  await sql`delete from cg.retention_policy where data_category = 'badges' and note like '%:%'`.execute(
    db,
  );
  await sql.raw(retentionFunction(FIELD_RECORDS_ROW + SAFETY_COMMS_ROWS)).execute(db);
}
