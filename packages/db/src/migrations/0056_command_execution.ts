/**
 * 0056 command executions (layer-7 task B; ADR-0044; CMD-20–CMD-28, CMD-37,
 * BRD:FR-C03–C07, AC-C04–C08, RULE-15).
 *
 * One row per command a person asked for: the catalogued command and its
 * version, the interpreted plan (arguments and the target with the version it
 * had), the plan's hash that a confirmation is bound to, the confirmation
 * class and who confirmed with what reason, the state, the verified result
 * from the operation's own response, and the link between an action and its
 * undo. Never the typed words: those belong to the 30-day personal
 * conversation (task C). The execution record is kept with the audit records
 * and nobody deletes it (CMD-36, RULE-15).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.command_execution (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      account_id uuid not null,
      execution_id uuid not null,
      input_kind text not null check (input_kind in ('shorthand', 'natural', 'alias')),
      command text not null,
      command_version integer not null,
      phase integer not null check (phase between 1 and 4),
      plan jsonb not null,
      plan_hash text not null,
      confirmation text not null
        check (confirmation in ('none', 'one_tap', 'full_review', 'second_person')),
      reversal text not null check (reversal in ('undo_15_min', 'compensating', 'none')),
      state text not null check (state in (
        'awaiting_confirmation', 'executing', 'succeeded', 'failed', 'canceled', 'stale')),
      confirmed_by uuid,
      confirmed_at timestamptz,
      reason text,
      result jsonb,
      reversal_of uuid references cg.command_execution(id),
      undone_by uuid references cg.command_execution(id),
      undo_until timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, execution_id)
    )`.execute(db);
  await sql`create index command_execution_account_idx
    on cg.command_execution (tenant_id, account_id, created_at desc)`.execute(db);
  await sql`create trigger command_execution_touch before update on cg.command_execution
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.command_execution')`.execute(db);
  await sql`drop policy tenant_delete on cg.command_execution`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.command_execution`.execute(db);
}
