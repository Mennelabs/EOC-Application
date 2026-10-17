/**
 * 0111 case management on the shared record (FL-13, FL-03, FL:FR-07, FL:FR-18,
 * FL:FR-27; docs/plans/case-management.md §3.1–3.3).
 *
 * - cg.case: one per report (and so per household), opened by the county or
 *   by a partner holding a grant; the lead organization; open, handed off
 *   (day 30) or closed with a reason. The frame the sections below hang on;
 *   it never copies the report.
 * - cg.help_received: help given with its source, type and dollar value, so
 *   a case manager checks for duplication of benefits before FEMA, SBA or
 *   other aid decides (FL-13). Append-only: an entry is voided with a reason,
 *   never changed or deleted (RULE-10). Dollar values are the financial data
 *   category (SEC-11).
 * - cg.recovery_plan_item: what is still unmet, who owns it, by when, and the
 *   referral it rides on.
 * Kept with the event under the default retention (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.case (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      party_id uuid references cg.party(id),
      event_id uuid references cg.event(id),
      status text not null default 'open' check (status in ('open', 'handed_off', 'closed')),
      lead_tenant_id uuid not null references cg.tenant(id),
      opened_by uuid references cg.account(id),
      opened_at timestamptz not null default now(),
      handed_off_at timestamptz,
      handed_off_to_tenant_id uuid references cg.tenant(id),
      handoff_referral_id uuid references cg.referral(id),
      closed_at timestamptz,
      closed_by uuid references cg.account(id),
      close_reason text check (char_length(close_reason) <= 500),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      unique (report_id),
      check ((status = 'closed') = (closed_at is not null)),
      check ((status = 'handed_off') = (handed_off_at is not null))
    );
    create index case_tenant_idx on cg.case (tenant_id, status, opened_at desc);
    create index case_lead_idx on cg.case (lead_tenant_id, status);
    select cg.apply_tenant_rls('cg.case');
    drop policy if exists tenant_delete on cg.case;

    create table cg.help_received (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      case_id uuid not null references cg.case(id),
      source_kind text not null check (source_kind in (
        'fema_ia', 'sba_loan', 'insurance', 'ngo_grant', 'ltrg_commitment', 'goods', 'services', 'other')),
      source_name text not null check (char_length(source_name) between 1 and 200),
      source_tenant_id uuid references cg.tenant(id),
      help_type text not null check (char_length(help_type) between 1 and 120),
      description text check (char_length(description) <= 1000),
      amount numeric(12, 2) check (amount is null or amount >= 0),
      given_on date not null,
      recorded_tenant_id uuid not null references cg.tenant(id),
      recorded_by uuid references cg.account(id),
      voided_at timestamptz,
      voided_by uuid references cg.account(id),
      void_reason text check (char_length(void_reason) <= 500),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      check ((voided_at is null) = (void_reason is null))
    );
    create index help_received_case_idx on cg.help_received (case_id, given_on desc);
    select cg.apply_tenant_rls('cg.help_received');
    drop policy if exists tenant_delete on cg.help_received;

    create table cg.recovery_plan_item (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      case_id uuid not null references cg.case(id),
      need_id uuid references cg.need(id),
      unmet text not null check (char_length(unmet) between 1 and 500),
      owner_tenant_id uuid references cg.tenant(id),
      owner_label text check (char_length(owner_label) <= 120),
      due_on date,
      status text not null default 'open' check (status in ('open', 'in_progress', 'met', 'dropped')),
      referral_id uuid references cg.referral(id),
      note text check (char_length(note) <= 1000),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id)
    );
    create index recovery_plan_item_case_idx on cg.recovery_plan_item (case_id, status);
    select cg.apply_tenant_rls('cg.recovery_plan_item');
    drop policy if exists tenant_delete on cg.recovery_plan_item;
  `.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists cg.recovery_plan_item;
    drop table if exists cg.help_received;
    drop table if exists cg.case;
  `.execute(db);
}
