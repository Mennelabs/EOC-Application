/**
 * 0058 personal command history (layer-7 task C; CMD-36, Section 30.2,
 * SEC-13, RULE-15). What a person typed into the command window and what the
 * window answered, encrypted, for that person alone: the row policies match
 * the account as well as the tenant, so an administrator of the same county
 * cannot read it either. Kept 30 days (the `command_conversation` retention
 * category), clearable by the person at any time, and never written from a
 * device the person marks as shared. The execution record in
 * cg.command_execution is the audit and is not touched by clearing this.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.command_message (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      account_id uuid not null,
      role text not null check (role in ('person', 'window')),
      body_enc bytea not null,
      execution_id uuid,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index command_message_account_idx
    on cg.command_message (tenant_id, account_id, created_at desc)`.execute(db);
  await sql`alter table cg.command_message enable row level security`.execute(db);
  await sql`alter table cg.command_message force row level security`.execute(db);
  await sql`create policy own_select on cg.command_message for select using (
    (tenant_id = cg.current_tenant_id() and account_id = cg.current_account_id()) or cg.is_system())`.execute(
    db,
  );
  await sql`create policy own_insert on cg.command_message for insert with check (
    tenant_id = cg.current_tenant_id() and account_id = cg.current_account_id())`.execute(db);
  await sql`create policy own_delete on cg.command_message for delete using (
    (tenant_id = cg.current_tenant_id() and account_id = cg.current_account_id()) or cg.is_system())`.execute(
    db,
  );
  await sql`grant select, insert, delete on cg.command_message to cg_app`.execute(db);
  await sql`grant select, delete on cg.command_message to cg_worker`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.command_message`.execute(db);
}
