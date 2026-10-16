/**
 * 0086 counts what the command window answered (FR-C11, CMD-38): per tenant,
 * day, command, kind of input and outcome, how many times. Clarifications,
 * refusals and unsupported requests keep no execution record, so without
 * these counts the clarification and duplicate rates could not be measured.
 * The counts hold no account, no words and no record: only the catalogued
 * command's name and what happened (measuring quality without unnecessary
 * sensitive logs).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.command_outcome (
      tenant_id uuid not null references cg.tenant(id),
      day date not null,
      command text not null,
      input_kind text not null check (input_kind in ('shorthand', 'natural')),
      outcome text not null,
      n integer not null default 0 check (n >= 0),
      primary key (tenant_id, day, command, input_kind, outcome)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.command_outcome')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.command_outcome`.execute(db);
  await loadDictionary(db);
}
