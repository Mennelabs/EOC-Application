/**
 * 0027 reminders (layer-3 plan §10 H; F09, REM-01, PUB-03, BRD:FR-16.03,
 * CNT-01, PUB-06): one row per subject and cycle for every reminder or
 * notice the worker raises on its own clock, so a reminder goes out once
 * whatever the schedule's pace or restarts (BRD:FR-00.06). The full F09
 * model (owner, snooze, acknowledge, escalation) arrives with missions in
 * layer 4, which is why this ledger carries its final name, `cg.notice_log`,
 * from the start (a database that ran this migration as `cg.reminder` is
 * renamed by 0028). Every column is in the dictionary (SEC-11); a retention
 * category of its own (SEC-13).
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
        (p_tenant, 'site_confirmations', interval '1 year', 'duration', 'PUB-03: confirmation history', p_actor)`;

function retentionFunction(extraRows: string): string {
  return `
    create or replace function cg.seed_retention_defaults(p_tenant uuid, p_actor uuid) returns void
    language sql as $$
      insert into cg.retention_policy (tenant_id, data_category, keep_for, rule, note, created_by)
      values${RETENTION_ROWS}${extraRows}
      on conflict do nothing
    $$`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.notice_log (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      kind text not null check (kind in ('site_reconfirm', 'site_hidden', 'resource_review', 'resource_link', 'resource_expired', 'contact_reverify', 'publication', 'publication_withdrawn')),
      subject_kind text not null check (subject_kind in ('site', 'resource', 'partner_contact', 'publication', 'tenant')),
      subject_id uuid not null,
      cycle_key text not null,
      due_at timestamptz not null,
      state text not null default 'active' check (state in ('active', 'sent', 'completed', 'canceled')),
      owner_account_id uuid,
      sent_at timestamptz,
      recipient_count integer not null default 0,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      unique (tenant_id, kind, subject_id, cycle_key)
    )`.execute(db);
  await sql`create index notice_log_due_idx on cg.notice_log (tenant_id, state, due_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.notice_log')`.execute(db);
  await sql
    .raw(
      retentionFunction(
        `,\n        (p_tenant, 'reminders', interval '1 year', 'duration', 'F09, REM-01: reminders and notices sent', p_actor)`,
      ),
    )
    .execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.notice_log cascade`.execute(db);
  await sql`delete from cg.retention_policy where data_category = 'reminders' and note like '%:%'`.execute(
    db,
  );
  await sql.raw(retentionFunction('')).execute(db);
}
