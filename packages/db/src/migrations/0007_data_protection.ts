/**
 * 0007 data protection:
 * - data_dictionary (SEC-11): every column's classification; populated by
 *   0009 from packages/db/src/dictionary.ts, and cg.undocumented_columns()
 *   must return nothing (tested);
 * - tenant_key (SEC-10, ADR-0009): per-tenant data keys wrapped by the key
 *   service, with versions for rotation;
 * - retention_policy, legal_hold, deletion_log (SEC-13).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.data_dictionary (
      table_name text not null,
      column_name text not null,
      classification text not null
        check (classification in ('public', 'internal', 'sensitive', 'restricted', 'cji')),
      retention_category text not null default 'records',
      description text,
      primary key (table_name, column_name)
    )`.execute(db);
  // Platform metadata: readable by the application, written only by migrations.
  await sql`revoke insert, update, delete on cg.data_dictionary from cg_app, cg_worker`.execute(db);
  await sql`
    create or replace function cg.undocumented_columns()
    returns table (table_name text, column_name text)
    language sql stable as $$
      select c.table_name::text, c.column_name::text
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'cg'
        and t.table_type = 'BASE TABLE'
        and not exists (
          select 1 from cg.data_dictionary d
          where d.table_name = c.table_name and d.column_name = c.column_name)
      order by 1, 2
    $$`.execute(db);

  await sql`
    create table cg.tenant_key (
      tenant_id uuid not null references cg.tenant(id),
      key_version integer not null,
      kek_name text not null,
      wrapped_dek text not null,
      status text not null default 'active' check (status in ('active', 'retired')),
      created_at timestamptz not null default now(),
      retired_at timestamptz,
      primary key (tenant_id, key_version)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.tenant_key')`.execute(db);
  await sql`drop policy tenant_delete on cg.tenant_key`.execute(db);

  await sql`
    create table cg.retention_policy (
      tenant_id uuid not null references cg.tenant(id),
      data_category text not null,
      keep_for interval,
      rule text not null default 'duration' check (rule in ('duration', 'on_confirm', 'external')),
      note text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      primary key (tenant_id, data_category),
      check ((rule = 'duration') = (keep_for is not null))
    )`.execute(db);
  await sql`create trigger retention_policy_touch before update on cg.retention_policy for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.retention_policy')`.execute(db);

  // SEC-13 defaults: 7 years, with the named exceptions. Called when a tenant is created.
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
        (p_tenant, 'cji', null, 'external', 'SEC-12: CJIS and state records rules in the enclave', p_actor)
      on conflict do nothing
    $$`.execute(db);

  await sql`
    create table cg.legal_hold (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      scope jsonb not null,
      reason text not null,
      placed_by uuid not null,
      placed_at timestamptz not null default now(),
      released_by uuid,
      released_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index legal_hold_active_idx on cg.legal_hold (tenant_id) where released_at is null`.execute(
    db,
  );
  await sql`create trigger legal_hold_touch before update on cg.legal_hold for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.legal_hold')`.execute(db);
  await sql`drop policy tenant_delete on cg.legal_hold`.execute(db);

  await sql`
    create table cg.deletion_log (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      data_category text not null,
      target_type text not null,
      deleted_count integer not null check (deleted_count >= 0),
      oldest timestamptz,
      newest timestamptz,
      ran_at timestamptz not null default now(),
      execution_id uuid not null
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.deletion_log')`.execute(db);
  await sql`drop policy tenant_update on cg.deletion_log`.execute(db);
  await sql`drop policy tenant_delete on cg.deletion_log`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'deletion_log',
    'legal_hold',
    'retention_policy',
    'tenant_key',
    'data_dictionary',
  ]) {
    await sql`drop table if exists ${sql.table(`cg.${t}`)} cascade`.execute(db);
  }
  await sql`drop function if exists cg.seed_retention_defaults(uuid, uuid)`.execute(db);
  await sql`drop function if exists cg.undocumented_columns()`.execute(db);
}
