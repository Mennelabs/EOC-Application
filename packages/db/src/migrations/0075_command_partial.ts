/**
 * 0075 lets a command execution end "partially succeeded" (CMD-30, CMD-24,
 * layer-7 plan §3 state model): a batch that changed some records and not
 * others says so, record by record, and never reads as all done or all
 * failed. No column changes. Down turns any partial execution into "failed"
 * (its per-record results stay in `result`) before restoring the old check.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.command_execution drop constraint command_execution_state_check`.execute(
    db,
  );
  await sql`
    alter table cg.command_execution add constraint command_execution_state_check
      check (state in ('awaiting_confirmation', 'executing', 'succeeded', 'partially_succeeded',
                       'failed', 'canceled', 'stale'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.command_execution no force row level security`.execute(db);
  await sql`update cg.command_execution set state = 'failed' where state = 'partially_succeeded'`.execute(
    db,
  );
  await sql`alter table cg.command_execution force row level security`.execute(db);
  await sql`alter table cg.command_execution drop constraint command_execution_state_check`.execute(
    db,
  );
  await sql`
    alter table cg.command_execution add constraint command_execution_state_check
      check (state in ('awaiting_confirmation', 'executing', 'succeeded', 'failed', 'canceled',
                       'stale'))`.execute(db);
}
