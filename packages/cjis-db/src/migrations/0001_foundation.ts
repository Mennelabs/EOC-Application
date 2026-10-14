/**
 * 0001 enclave foundation (SEC-12, ADR-0021, ADR-0037): the `cjis` schema in
 * the enclave's own database, row-level security keyed to the owning agency,
 * and the enclave data dictionary (SEC-11). Nothing here is shared with the
 * platform database: different instance, roles, keys and network.
 *
 * Roles (created by infra/cjis-postgres/init.sh on first start):
 * - cjis_migrator owns the schema (DDL);
 * - cjis_app serves requests; every query runs inside `withAgency`, so row
 *   security limits it to the caller's agency;
 * - cjis_job runs the enclave worker's system jobs (identity outbox,
 *   retention, inactivity, sign-in events) and the provisioning one-shot.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from '../dictionary.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create schema if not exists cjis`.execute(db);
  await sql`revoke all on schema cjis from public`.execute(db);
  await sql`grant usage on schema cjis to cjis_app, cjis_job`.execute(db);
  await sql`alter default privileges in schema cjis grant select, insert, update, delete on tables to cjis_app, cjis_job`.execute(
    db,
  );
  await sql`alter default privileges in schema cjis grant usage, select on sequences to cjis_app, cjis_job`.execute(
    db,
  );
  await sql`alter default privileges in schema cjis grant execute on functions to cjis_app, cjis_job`.execute(
    db,
  );

  await sql`
    create or replace function cjis.current_agency_id() returns uuid
    language sql stable as $$
      select nullif(current_setting('app.agency_id', true), '')::uuid
    $$`.execute(db);
  await sql`
    create or replace function cjis.current_person_id() returns uuid
    language sql stable as $$
      select nullif(current_setting('app.person_id', true), '')::uuid
    $$`.execute(db);
  // System jobs run as their own database role; the API's role can never claim it.
  await sql`
    create or replace function cjis.is_system() returns boolean
    language sql stable as $$ select current_user = 'cjis_job' $$`.execute(db);

  // BRD:FR-00.05: every update bumps the version and the time.
  await sql`
    create or replace function cjis.touch() returns trigger
    language plpgsql as $$
    begin
      new.updated_at := now();
      new.version := old.version + 1;
      return new;
    end $$`.execute(db);

  await sql`
    create or replace function cjis.apply_agency_rls(tbl regclass) returns void
    language plpgsql as $$
    begin
      execute format('alter table %s enable row level security', tbl);
      execute format('alter table %s force row level security', tbl);
      execute format($p$create policy agency_select on %s for select using (
        agency_id = cjis.current_agency_id() or cjis.is_system())$p$, tbl);
      execute format($p$create policy agency_insert on %s for insert with check (
        agency_id = cjis.current_agency_id() or cjis.is_system())$p$, tbl);
      execute format($p$create policy agency_update on %s for update
        using (agency_id = cjis.current_agency_id() or cjis.is_system())
        with check (agency_id = cjis.current_agency_id() or cjis.is_system())$p$, tbl);
      execute format($p$create policy agency_delete on %s for delete using (
        agency_id = cjis.current_agency_id() or cjis.is_system())$p$, tbl);
    end $$`.execute(db);

  // SEC-11 for the enclave: every column classified; the API's roles cannot change it.
  await sql`
    create table cjis.data_dictionary (
      table_name text not null,
      column_name text not null,
      classification text not null check (classification in ('public', 'internal', 'sensitive', 'restricted', 'cji')),
      retention_category text not null,
      description text,
      primary key (table_name, column_name)
    )`.execute(db);
  await sql`revoke insert, update, delete on cjis.data_dictionary from cjis_app, cjis_job`.execute(
    db,
  );
  await sql`
    create or replace function cjis.undocumented_columns()
    returns table (table_name text, column_name text)
    language sql stable as $$
      select c.table_name::text, c.column_name::text
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'cjis' and t.table_type = 'BASE TABLE'
        and not exists (
          select 1 from cjis.data_dictionary d
          where d.table_name = c.table_name and d.column_name = c.column_name)
    $$`.execute(db);

  // A criminal-justice agency. Agencies are created by provisioning (system),
  // never by an API caller; a caller sees only its own agency.
  await sql`
    create table cjis.agency (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      agency_identifier text not null unique,
      platform_county text,
      status text not null default 'active' check (status in ('active', 'suspended')),
      exercise boolean not null default true,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db);
  await sql`create trigger agency_touch before update on cjis.agency for each row execute function cjis.touch()`.execute(
    db,
  );
  await sql`alter table cjis.agency enable row level security`.execute(db);
  await sql`alter table cjis.agency force row level security`.execute(db);
  await sql`create policy agency_own on cjis.agency for select using (
              id = cjis.current_agency_id() or cjis.is_system())`.execute(db);
  await sql`create policy agency_system on cjis.agency for all using (cjis.is_system())
              with check (cjis.is_system())`.execute(db);

  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop schema if exists cjis cascade`.execute(db);
}
