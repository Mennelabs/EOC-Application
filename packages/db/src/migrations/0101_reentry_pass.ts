/**
 * 0101 resident re-entry passes and the checks made at the perimeter
 * (FL:FR-03: "scan resident re-entry passes and approved contractor and
 * volunteer credentials at checkpoints; log entries. No criminal-justice data
 * (SEC-12)"). A pass lets a household back into a closed zone of an event for
 * a window of time: the zone, how many people, and who and which home it is
 * for (the name and address encrypted, read only by roles that issue or check
 * passes). Its code is printed once and kept only as a hash, like a badge's.
 * Every scan of a pass is logged with its checkpoint, the time and the result;
 * the log names no one. Both are field records of their event (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.reentry_pass (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      code_hash bytea not null,
      zone text not null,
      holder_name_enc bytea not null,
      address_enc bytea not null,
      people integer not null default 1 check (people between 1 and 20),
      valid_from timestamptz not null default now(),
      valid_to timestamptz not null,
      state text not null default 'active' check (state in ('active', 'revoked')),
      report_id uuid references cg.report(id),
      revoked_at timestamptz,
      revoked_by uuid,
      revoke_reason text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, code_hash),
      check (valid_to > valid_from),
      check ((state = 'revoked') = (revoked_at is not null))
    )`.execute(db);
  await sql`create index reentry_pass_event_idx on cg.reentry_pass (tenant_id, event_id, created_at desc)`.execute(
    db,
  );
  await sql`create trigger reentry_pass_touch before update on cg.reentry_pass for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.reentry_pass')`.execute(db);
  // A pass is revoked, never deleted by the application; only the retention sweep removes it.
  await sql`drop policy tenant_delete on cg.reentry_pass`.execute(db);
  await sql`create policy retention_delete on cg.reentry_pass for delete using (cg.is_system())`.execute(
    db,
  );
  await sql`
    create table cg.reentry_check (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      pass_id uuid not null references cg.reentry_pass(id),
      checkpoint text,
      result text not null check (result in ('valid', 'expired', 'revoked', 'not_yet_valid')),
      checked_by uuid,
      checked_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index reentry_check_event_idx on cg.reentry_check (tenant_id, event_id, checked_at desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.reentry_check')`.execute(db);
  // The log of entries is written once and never changed.
  await sql`drop policy tenant_update on cg.reentry_check`.execute(db);
  await sql`drop policy tenant_delete on cg.reentry_check`.execute(db);
  await sql`create policy retention_delete on cg.reentry_check for delete using (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.reentry_check`.execute(db);
  await sql`drop table if exists cg.reentry_pass`.execute(db);
  await loadDictionary(db);
}
