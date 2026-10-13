/**
 * 0014 needs, consent and post-submission answers (layer-2 plan §2; NED-01–03,
 * INT-19, EQ-13, ACM-01, RULE-16, ACC-45). Needs are their own record so a
 * household can ask for help without a damage report and the reverse.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.need (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid references cg.report(id),
      subject_party_id uuid references cg.party(id),
      event_id uuid references cg.event(id),
      category text not null,
      detail text,
      status text not null default 'open' check (status in ('open', 'claimed', 'met', 'closed', 'withdrawn')),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index need_report_idx on cg.need (report_id)`.execute(db);
  await sql`create index need_open_idx on cg.need (tenant_id, event_id, status)`.execute(db);
  await sql`create trigger need_touch before update on cg.need for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.need')`.execute(db);

  await sql`
    create table cg.consent (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      party_id uuid not null references cg.party(id),
      report_id uuid references cg.report(id),
      org_type text not null,
      granted boolean not null default false,
      granted_at timestamptz,
      withdrawn_at timestamptz,
      channel text check (channel in ('web', 'sms', 'voice', 'assisted', 'staff')),
      evidence jsonb,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create unique index consent_unique_idx on cg.consent (party_id, org_type, coalesce(report_id, '00000000-0000-0000-0000-000000000000'::uuid))`.execute(
    db,
  );
  await sql`create trigger consent_touch before update on cg.consent for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.consent')`.execute(db);

  // Optional questions asked after the report is saved, kept apart from it (INT-19).
  await sql`
    create table cg.post_submission_answers (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      report_id uuid not null references cg.report(id),
      aggregate_answers jsonb not null default '{}'::jsonb,
      restricted_answers_enc bytea,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version integer not null default 1,
      created_by uuid,
      updated_by uuid,
      unique (report_id)
    )`.execute(db);
  await sql`create trigger post_submission_answers_touch before update on cg.post_submission_answers for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.post_submission_answers')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.post_submission_answers cascade`.execute(db);
  await sql`drop table if exists cg.consent cascade`.execute(db);
  await sql`drop table if exists cg.need cascade`.execute(db);
}
