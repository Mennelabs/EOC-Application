/**
 * 0016 AI use register and extractions (AIG-01, AIG-03, AIG-06, AIG-12,
 * INT-13), new retention categories for the layer-2 tables (SEC-13) and the
 * data-dictionary reload for migrations 0011–0016 (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.ai_use_register (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      feature text not null,
      provider text not null,
      model text not null,
      model_version text,
      data_sent text not null,
      decision_informed text not null,
      human_checkpoint text not null,
      owner text not null,
      us_region boolean not null default false,
      zero_retention boolean not null default false,
      no_training boolean not null default false,
      evaluation jsonb not null default '{}'::jsonb,
      enabled boolean not null default false,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, feature)
    )`.execute(db);
  await sql`create trigger ai_use_register_touch before update on cg.ai_use_register for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.ai_use_register')`.execute(db);

  await sql`
    create table cg.extraction (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      execution_id uuid not null,
      input_hash bytea not null,
      provider text not null,
      model text not null,
      output jsonb not null,
      confirmed jsonb,
      rejected jsonb,
      filtered_reasons text[] not null default '{}',
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index extraction_execution_idx on cg.extraction (execution_id)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.extraction')`.execute(db);
  await sql`drop policy tenant_delete on cg.extraction`.execute(db);

  // Retention categories for the new tables (SEC-13); existing tenants get the rows now.
  await sql`
    create or replace function cg.seed_retention_defaults(p_tenant uuid, p_actor uuid) returns void
    language sql as $$
      insert into cg.retention_policy (tenant_id, data_category, keep_for, rule, note, created_by)
      values
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
        (p_tenant, 'abuse_signals', interval '90 days', 'duration', 'SEC-17: rate-limit and risk evidence', p_actor)
      on conflict do nothing
    $$`.execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);

  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.extraction cascade`.execute(db);
  await sql`drop table if exists cg.ai_use_register cascade`.execute(db);
}
