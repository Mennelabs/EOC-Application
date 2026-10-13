/**
 * 0034 field sync (layer-4 plan §2 and §5, task B; NFR-07, NFR-08, FLD-13,
 * FLD-14, SCL-06): the change feed the field app reads from a cursor, scoped
 * by person, team, area, event or tenant so a phone receives only what its
 * holder may see; and the client command ledger keyed by the client's UUID,
 * so a batch replayed twice changes nothing and a stale command gets the
 * current record. Every column is in the dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.change_feed (
      seq bigint generated always as identity primary key,
      tenant_id uuid not null references cg.tenant(id),
      scope_kind text not null check (scope_kind in ('person', 'team', 'area', 'event', 'tenant')),
      scope_id uuid,
      record_type text not null,
      record_id uuid not null,
      record_version integer,
      op text not null check (op in ('upsert', 'delete')),
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index change_feed_cursor_idx on cg.change_feed (tenant_id, seq)`.execute(db);
  await sql`create index change_feed_scope_idx on cg.change_feed (tenant_id, scope_kind, scope_id, seq)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.change_feed')`.execute(db);
  await sql`drop policy tenant_update on cg.change_feed`.execute(db);
  await sql`drop policy tenant_delete on cg.change_feed`.execute(db);

  await sql`
    create table cg.client_command (
      id uuid primary key,
      tenant_id uuid not null references cg.tenant(id),
      device_id uuid references cg.field_device(id),
      account_id uuid references cg.account(id),
      personnel_id uuid references cg.personnel(id),
      kind text not null,
      payload jsonb not null default '{}'::jsonb,
      client_at timestamptz,
      received_at timestamptz not null default now(),
      applied_at timestamptz,
      result text not null default 'received' check (result in ('received', 'applied', 'duplicate', 'conflict', 'rejected')),
      result_detail jsonb not null default '{}'::jsonb,
      record_type text,
      record_id uuid,
      record_version integer,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index client_command_device_idx on cg.client_command (tenant_id, device_id, received_at)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.client_command')`.execute(db);
  await sql`drop policy tenant_delete on cg.client_command`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.client_command cascade`.execute(db);
  await sql`drop table if exists cg.change_feed cascade`.execute(db);
}
