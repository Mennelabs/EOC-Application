/**
 * 0112 appointments and the recovery centre (FL:FR-12, FL:FR-18;
 * docs/plans/case-management.md §3.4–3.5).
 *
 * - cg.appointment: a case's appointment with an organization or table, at a
 *   place, at a time, for a purpose. Scheduling it texts the survivor through
 *   the message pipeline and a reminder the day before; the message ids are
 *   kept here. The text carries the time and place, never the purpose (plan
 *   §5.5). Never deleted: cancelled with a reason.
 * - cg.marc_visit: a survivor's visit to a recovery centre: the label the
 *   survivor gave at the door (a first name or the reference code, nothing
 *   more; plan §5.3), when they arrived, and how the visit ended.
 * - cg.marc_stop: the tables to see, in order; which is current; each hand-off
 *   with its one-line "why", so the survivor does not retell their story.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.appointment (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      case_id uuid not null references cg.case(id),
      with_tenant_id uuid references cg.tenant(id),
      with_label text not null check (char_length(with_label) between 1 and 200),
      site_id uuid references cg.site(id),
      place text not null check (char_length(place) between 1 and 300),
      starts_at timestamptz not null,
      ends_at timestamptz,
      purpose text check (char_length(purpose) <= 500),
      status text not null default 'scheduled'
        check (status in ('scheduled', 'kept', 'missed', 'cancelled')),
      notice_channel text check (notice_channel in ('sms', 'email')),
      notice_queued_at timestamptz,
      notice_message_id uuid references cg.message(id),
      reminder_queued_at timestamptz,
      reminder_message_id uuid references cg.message(id),
      cancel_reason text check (char_length(cancel_reason) <= 500),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      check ((status = 'cancelled') = (cancel_reason is not null))
    );
    create index appointment_case_idx on cg.appointment (case_id, starts_at);
    create index appointment_due_idx on cg.appointment (tenant_id, starts_at)
      where status = 'scheduled' and reminder_queued_at is null;
    select cg.apply_tenant_rls('cg.appointment');
    drop policy if exists tenant_delete on cg.appointment;

    create table cg.marc_visit (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      case_id uuid references cg.case(id),
      report_id uuid references cg.report(id),
      label text not null check (char_length(label) between 1 and 80),
      arrived_at timestamptz not null default now(),
      status text not null default 'waiting'
        check (status in ('waiting', 'in_progress', 'done', 'left')),
      ended_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      check ((status in ('done', 'left')) = (ended_at is not null))
    );
    create index marc_visit_site_idx on cg.marc_visit (site_id, status, arrived_at);
    select cg.apply_tenant_rls('cg.marc_visit');

    create table cg.marc_stop (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      visit_id uuid not null references cg.marc_visit(id),
      seq integer not null check (seq between 1 and 20),
      table_tenant_id uuid references cg.tenant(id),
      table_label text not null check (char_length(table_label) between 1 and 120),
      status text not null default 'waiting'
        check (status in ('waiting', 'current', 'done', 'skipped')),
      started_at timestamptz,
      done_at timestamptz,
      handoff_note text check (char_length(handoff_note) <= 200),
      handed_by uuid references cg.account(id),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      unique (visit_id, seq)
    );
    create index marc_stop_table_idx on cg.marc_stop (table_tenant_id, status);
    select cg.apply_tenant_rls('cg.marc_stop');
  `.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists cg.marc_stop;
    drop table if exists cg.marc_visit;
    drop table if exists cg.appointment;
  `.execute(db);
}
