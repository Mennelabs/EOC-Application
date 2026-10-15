/**
 * 0050 equity and coverage alerts (layer-6 task G; EQ-11, EQ-12, EQ-13,
 * CON-07): the worker raises an alert when a tract or an income band is
 * under-reported against the structure inventory, or a group waits longer
 * for review or help than the tenant's threshold allows; it clears the
 * alert when that no longer holds. Staff acknowledge an alert and record
 * the outreach taken. The value is null when the figure is hidden (fewer
 * than 11 people or households). Only the system raises or clears; staff
 * only acknowledge. Every column is in the dictionary; RLS.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.equity_alert (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      kind text not null check (kind in ('coverage', 'review_gap', 'help_gap')),
      subject_kind text not null
        check (subject_kind in ('tract', 'income_band', 'tenure', 'language', 'channel')),
      subject text not null check (char_length(subject) between 1 and 80),
      label text not null check (char_length(label) <= 200),
      value numeric,
      threshold numeric not null,
      outreach text not null check (char_length(outreach) <= 1000),
      raised_at timestamptz not null default now(),
      cleared_at timestamptz,
      acknowledged_by uuid,
      acknowledged_at timestamptz,
      action_taken text check (char_length(action_taken) <= 1000),
      version integer not null default 1,
      updated_at timestamptz not null default now(),
      check ((acknowledged_at is null) = (acknowledged_by is null)),
      check (acknowledged_at is null or action_taken is not null)
    )`.execute(db);
  await sql`create unique index equity_alert_open on cg.equity_alert (event_id, kind, subject_kind, subject) where cleared_at is null`.execute(
    db,
  );
  await sql`create trigger equity_alert_touch before update on cg.equity_alert for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.equity_alert')`.execute(db);
  // The system raises and clears; staff acknowledge (updates); nothing is deleted.
  await sql`drop policy tenant_insert on cg.equity_alert`.execute(db);
  await sql`drop policy tenant_delete on cg.equity_alert`.execute(db);
  await sql`create policy system_insert on cg.equity_alert for insert with check (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.equity_alert`.execute(db);
  await loadDictionary(db);
}
