/**
 * 0076 command window response times (CMD-38, Section 30.2). Each execution
 * keeps how long the plan took to prepare (parsing, the model's reading of
 * plain words, resolving records) and how long the confirmed operation took,
 * in milliseconds, so the targets (shorthand under 1 s, interpretation under
 * 2.5 s, execution under 2 s at the 95th percentile) are measured, not
 * assumed. Durations only: nothing the person typed.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.command_execution
    add column prepare_ms integer check (prepare_ms >= 0),
    add column execute_ms integer check (execute_ms >= 0)`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.command_execution
    drop column if exists prepare_ms,
    drop column if exists execute_ms`.execute(db);
  await loadDictionary(db);
}
