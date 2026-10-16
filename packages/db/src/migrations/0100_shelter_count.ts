/**
 * 0100 shelter counts imported from the Red Cross system (CON-16: "import of
 * shelter counts from the Red Cross system without personal details"). A row
 * is one shelter's count at one moment as the Red Cross reported it: its id
 * in their records, its name, status, people staying and capacity. Nothing
 * about any person is accepted or kept. A county site can carry the shelter's
 * id from those records (`site.external_ref`), so a count for it also updates
 * the site's occupancy; a shelter the county has no site for stays a count.
 * Counts are field records of their event (SEC-13, the `field_records`
 * category), kept until the event has been closed for the period.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.site add column external_ref text`.execute(db);
  await sql`create unique index site_external_ref_idx on cg.site (tenant_id, external_ref)
    where external_ref is not null`.execute(db);
  await sql`
    create table cg.shelter_count (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      source text not null check (source in ('red_cross')),
      external_ref text not null,
      shelter_name text not null,
      status text check (status in ('open', 'limited', 'full', 'closed')),
      population integer check (population >= 0),
      capacity integer check (capacity >= 0),
      as_of timestamptz not null,
      site_id uuid references cg.site(id),
      imported_by uuid,
      created_at timestamptz not null default now(),
      unique (tenant_id, event_id, source, external_ref, as_of)
    )`.execute(db);
  await sql`create index shelter_count_latest_idx
    on cg.shelter_count (tenant_id, event_id, external_ref, as_of desc)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.shelter_count')`.execute(db);
  // A count is what the Red Cross reported; it is never edited, and only the retention sweep removes it.
  await sql`drop policy tenant_update on cg.shelter_count`.execute(db);
  await sql`drop policy tenant_delete on cg.shelter_count`.execute(db);
  await sql`create policy retention_delete on cg.shelter_count for delete using (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.shelter_count`.execute(db);
  await sql`drop index if exists cg.site_external_ref_idx`.execute(db);
  await sql`alter table cg.site drop column if exists external_ref`.execute(db);
  await loadDictionary(db);
}
