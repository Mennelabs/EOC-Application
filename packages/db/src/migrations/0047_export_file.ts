/**
 * 0047 export files (layer-6 task F; DCL:DEC-11, DEC-12, SEC-13, SEC-18,
 * GATE-07): one row per requested export, the IDA package (ZIP) or an
 * issued official report (PDF or CSV). Staff request it; the worker builds
 * it into object storage and records the file's size and SHA-256, the FEMA
 * form and mapping versions used, and the figures the tests reconcile.
 * Requests are written by staff, results only by the system; nothing is
 * deleted (retention, SEC-13). Every column is in the dictionary; RLS.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.export_file (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      client_uuid uuid not null,
      kind text not null check (kind in ('ida_package', 'official_report')),
      format text not null check (format in ('zip', 'pdf', 'csv')),
      report_id uuid references cg.official_report(id),
      jurisdiction_tenant_id uuid references cg.tenant(id),
      status text not null default 'queued' check (status in ('queued', 'ready', 'failed')),
      mappings jsonb not null default '{}'::jsonb,
      figures jsonb not null default '{}'::jsonb,
      file_name text,
      object_key text,
      bytes bigint check (bytes >= 0),
      sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
      error text,
      requested_by uuid not null,
      reason text check (char_length(reason) <= 500),
      created_at timestamptz not null default now(),
      ready_at timestamptz,
      unique (tenant_id, client_uuid),
      check ((kind = 'official_report') = (report_id is not null)),
      check (kind <> 'ida_package' or format = 'zip'),
      check (status <> 'ready' or (object_key is not null and sha256 is not null))
    )`.execute(db);
  await sql`create index export_file_event_idx on cg.export_file (tenant_id, event_id, created_at desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.export_file')`.execute(db);
  // Staff ask; only the worker writes the result.
  await sql`drop policy tenant_update on cg.export_file`.execute(db);
  await sql`drop policy tenant_delete on cg.export_file`.execute(db);
  await sql`create policy system_update on cg.export_file for update using (cg.is_system()) with check (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.export_file`.execute(db);
  await loadDictionary(db);
}
