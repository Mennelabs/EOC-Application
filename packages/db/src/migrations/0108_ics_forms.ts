/**
 * 0108 ICS forms as documents (CON-13; layer-8 plan §4 and §8).
 *
 * - cg.incident_objective: the ICS 202 objectives of an operational period,
 *   entered by planning, each with the position that owns it and a status.
 *   They feed the ICS 201 briefing and the wall display.
 * - cg.general_message: an ICS 213 general message: to, from, subject, body,
 *   approved by a second person (never the writer: ADM-05 G4), sent (to the
 *   field as a field message when an audience is named), and the reply.
 * - cg.ics_form_issue: each issued form (201, 213, 213 RR, 214, 309) frozen
 *   with its scope, content, edition and SHA-256, like an official report's
 *   snapshot (RULE-10): never updated or deleted, only superseded by a later
 *   issue. PDFs and CSVs are drawn from the frozen content.
 *
 * Forms carry staff names and ICS positions, never a resident (plan §12).
 * All three are public records of the event, kept with it (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.incident_objective (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      period_from timestamptz not null,
      period_to timestamptz not null,
      position integer not null check (position between 1 and 200),
      objective text not null check (char_length(objective) between 3 and 1000),
      owner_position text check (char_length(owner_position) <= 120),
      status text not null default 'open' check (status in ('open', 'met', 'dropped')),
      note text check (char_length(note) <= 2000),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      check (period_to > period_from)
    );
    create index incident_objective_event_idx
      on cg.incident_objective (tenant_id, event_id, period_from, position);
    select cg.apply_tenant_rls('cg.incident_objective');
    drop policy if exists tenant_delete on cg.incident_objective;

    create table cg.general_message (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      message_number text not null check (char_length(message_number) between 3 and 40),
      to_name text not null check (char_length(to_name) between 1 and 120),
      to_position text check (char_length(to_position) <= 120),
      from_name text not null check (char_length(from_name) between 1 and 120),
      from_position text check (char_length(from_position) <= 120),
      subject text not null check (char_length(subject) between 1 and 200),
      body text not null check (char_length(body) between 1 and 4000),
      status text not null default 'draft'
        check (status in ('draft', 'approved', 'sent', 'replied', 'cancelled')),
      approved_at timestamptz,
      approved_by uuid references cg.account(id),
      sent_at timestamptz,
      sent_by uuid references cg.account(id),
      field_message_id uuid references cg.field_message(id),
      reply text check (char_length(reply) <= 4000),
      reply_by_name text check (char_length(reply_by_name) <= 120),
      reply_by_position text check (char_length(reply_by_position) <= 120),
      replied_at timestamptz,
      replied_by uuid references cg.account(id),
      cancelled_at timestamptz,
      cancelled_by uuid references cg.account(id),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      unique (tenant_id, message_number),
      check (approved_by is null or created_by is null or approved_by <> created_by)
    );
    create index general_message_event_idx on cg.general_message (tenant_id, event_id, created_at desc);
    select cg.apply_tenant_rls('cg.general_message');
    drop policy if exists tenant_delete on cg.general_message;

    create table cg.ics_form_issue (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      form text not null check (form in ('ics_201', 'ics_213', 'ics_213rr', 'ics_214', 'ics_309')),
      edition text not null check (char_length(edition) between 1 and 200),
      sequence integer not null check (sequence > 0),
      title text not null check (char_length(title) between 1 and 200),
      scope jsonb not null default '{}'::jsonb,
      content jsonb not null,
      content_hash text not null check (char_length(content_hash) = 64),
      issued_at timestamptz not null default now(),
      issued_by uuid not null references cg.account(id),
      created_at timestamptz not null default now(),
      unique (tenant_id, event_id, form, sequence)
    );
    create index ics_form_issue_event_idx on cg.ics_form_issue (tenant_id, event_id, form, issued_at desc);
    select cg.apply_tenant_rls('cg.ics_form_issue');
    drop policy if exists tenant_delete on cg.ics_form_issue;
    drop policy if exists tenant_update on cg.ics_form_issue;
  `.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists cg.ics_form_issue;
    drop table if exists cg.general_message;
    drop table if exists cg.incident_objective;
  `.execute(db);
}
