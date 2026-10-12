/**
 * 0002 tenancy: helper functions used by every later migration, the tenant
 * hierarchy (SCL-01), jurisdictions, licensing (SCL-10), data-sharing
 * agreements and versioned tenant configuration (SCL-07).
 *
 * Row-level security (SEC-05, ADR-0006) reads these session settings, set
 * with SET LOCAL inside each request transaction:
 *   app.tenant_id    the acting tenant (writes)
 *   app.tenant_ids   tenants whose records may be read: own tenant plus
 *                    grantors of signed data-sharing agreements
 *   app.tenant_path  the acting tenant's ltree path (own subtree)
 * The cg_worker role (system jobs) passes every policy; the API never holds
 * its credentials.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`grant usage on schema cg to cg_worker`.execute(db);
  await sql`alter default privileges in schema cg
            grant select, insert, update, delete on tables to cg_worker`.execute(db);
  await sql`alter default privileges in schema cg
            grant usage, select on sequences to cg_worker`.execute(db);
  await sql`alter default privileges in schema cg grant execute on functions to cg_app, cg_worker`.execute(
    db,
  );

  await sql`
    create or replace function cg.current_tenant_id() returns uuid
    language sql stable as $$
      select nullif(current_setting('app.tenant_id', true), '')::uuid
    $$`.execute(db);
  await sql`
    create or replace function cg.visible_tenant_ids() returns uuid[]
    language sql stable as $$
      select coalesce(string_to_array(nullif(current_setting('app.tenant_ids', true), ''), ',')::uuid[], '{}')
    $$`.execute(db);
  await sql`
    create or replace function cg.current_tenant_path() returns ltree
    language sql stable as $$
      select nullif(current_setting('app.tenant_path', true), '')::ltree
    $$`.execute(db);
  await sql`
    create or replace function cg.current_account_id() returns uuid
    language sql stable as $$
      select nullif(current_setting('app.account_id', true), '')::uuid
    $$`.execute(db);
  await sql`
    create or replace function cg.is_system() returns boolean
    language sql stable as $$ select current_user = 'cg_worker' $$`.execute(db);

  // FR-00.05: every update bumps the version and timestamp even if the
  // application forgets; the application still checks the expected version.
  await sql`
    create or replace function cg.touch() returns trigger
    language plpgsql as $$
    begin
      new.updated_at := now();
      new.version := old.version + 1;
      return new;
    end $$`.execute(db);

  await sql`
    create or replace function cg.apply_tenant_rls(tbl regclass) returns void
    language plpgsql as $$
    begin
      execute format('alter table %s enable row level security', tbl);
      execute format('alter table %s force row level security', tbl);
      execute format($p$create policy tenant_select on %s for select using (
        tenant_id = cg.current_tenant_id() or tenant_id = any(cg.visible_tenant_ids()) or cg.is_system())$p$, tbl);
      execute format($p$create policy tenant_insert on %s for insert with check (
        tenant_id = cg.current_tenant_id() or cg.is_system())$p$, tbl);
      execute format($p$create policy tenant_update on %s for update
        using (tenant_id = cg.current_tenant_id() or cg.is_system())
        with check (tenant_id = cg.current_tenant_id() or cg.is_system())$p$, tbl);
      execute format($p$create policy tenant_delete on %s for delete using (
        tenant_id = cg.current_tenant_id() or cg.is_system())$p$, tbl);
    end $$`.execute(db);

  await sql`
    create table cg.tenant (
      id uuid primary key default gen_random_uuid(),
      kind text not null check (kind in ('state', 'region', 'county', 'city', 'partner_org')),
      parent_id uuid references cg.tenant(id),
      path ltree not null,
      slug citext not null unique,
      name text not null,
      timezone text not null default 'America/Chicago',
      locales text[] not null default '{en}',
      status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
      security_contact_email citext,
      branding jsonb not null default '{}'::jsonb,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check ((kind = 'state') = (parent_id is null))
    )`.execute(db);
  await sql`create index tenant_path_gist on cg.tenant using gist (path)`.execute(db);
  await sql`create index tenant_parent_idx on cg.tenant (parent_id)`.execute(db);
  await sql`create trigger tenant_touch before update on cg.tenant for each row execute function cg.touch()`.execute(
    db,
  );
  // Path label = id without hyphens, so the tree never depends on mutable names.
  await sql`
    create or replace function cg.tenant_set_path() returns trigger
    language plpgsql as $$
    declare parent_path ltree;
    begin
      if new.parent_id is not null then
        select path into parent_path from cg.tenant where id = new.parent_id;
        if parent_path is null then
          raise exception 'parent tenant not visible or missing' using errcode = 'foreign_key_violation';
        end if;
      end if;
      new.path := coalesce(parent_path, ''::ltree) || replace(new.id::text, '-', '_')::ltree;
      return new;
    end $$`.execute(db);
  await sql`create trigger tenant_path before insert on cg.tenant for each row execute function cg.tenant_set_path()`.execute(
    db,
  );
  await sql`alter table cg.tenant enable row level security`.execute(db);
  await sql`alter table cg.tenant force row level security`.execute(db);
  await sql`
    create policy tenant_select on cg.tenant for select using (
      id = cg.current_tenant_id()
      or id = any(cg.visible_tenant_ids())
      or (cg.current_tenant_path() is not null and path <@ cg.current_tenant_path())
      or cg.is_system())`.execute(db);
  // Only a tenant creates its own children; root (state) tenants come from system bootstrap.
  await sql`
    create policy tenant_insert on cg.tenant for insert with check (
      parent_id = cg.current_tenant_id() or cg.is_system())`.execute(db);
  await sql`
    create policy tenant_update on cg.tenant for update using (
      (cg.current_tenant_path() is not null and path <@ cg.current_tenant_path()) or cg.is_system())`.execute(
    db,
  );
  // No delete policy: tenants are closed, never deleted (history must survive).

  await sql`
    create table cg.jurisdiction (
      tenant_id uuid primary key references cg.tenant(id),
      fips text,
      geom geometry(MultiPolygon, 4326),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index jurisdiction_geom_gist on cg.jurisdiction using gist (geom)`.execute(db);
  await sql`create trigger jurisdiction_touch before update on cg.jurisdiction for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.jurisdiction')`.execute(db);

  // SCL-10: subscription per jurisdiction; never meters resident reports.
  await sql`
    create table cg.license (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      tier text not null,
      population_served integer check (population_served >= 0),
      term_start date not null,
      term_end date not null check (term_end > term_start),
      covers_tenant_ids uuid[] not null default '{}',
      status text not null default 'active' check (status in ('active', 'expired', 'cancelled')),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index license_tenant_idx on cg.license (tenant_id)`.execute(db);
  await sql`create trigger license_touch before update on cg.license for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.license')`.execute(db);

  // SCL-01: sharing between tenants is explicit. Both parties see the agreement.
  await sql`
    create table cg.data_sharing_agreement (
      id uuid primary key default gen_random_uuid(),
      from_tenant_id uuid not null references cg.tenant(id),
      to_tenant_id uuid not null references cg.tenant(id),
      scope text not null check (scope in ('deidentified_counts', 'consented_records', 'full_records')),
      data_categories text[] not null default '{}',
      status text not null default 'draft' check (status in ('draft', 'signed', 'revoked')),
      terms jsonb not null default '{}'::jsonb,
      signed_at timestamptz,
      signed_by uuid,
      revoked_at timestamptz,
      revoked_by uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (from_tenant_id <> to_tenant_id)
    )`.execute(db);
  await sql`create index dsa_from_idx on cg.data_sharing_agreement (from_tenant_id)`.execute(db);
  await sql`create index dsa_to_idx on cg.data_sharing_agreement (to_tenant_id)`.execute(db);
  await sql`create trigger dsa_touch before update on cg.data_sharing_agreement for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`alter table cg.data_sharing_agreement enable row level security`.execute(db);
  await sql`alter table cg.data_sharing_agreement force row level security`.execute(db);
  await sql`
    create policy dsa_select on cg.data_sharing_agreement for select using (
      from_tenant_id = cg.current_tenant_id() or to_tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(
    db,
  );
  await sql`
    create policy dsa_insert on cg.data_sharing_agreement for insert with check (
      from_tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(db);
  await sql`
    create policy dsa_update on cg.data_sharing_agreement for update using (
      from_tenant_id = cg.current_tenant_id() or to_tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(
    db,
  );

  // SCL-07: per-tenant configuration without code changes; every change keeps history.
  await sql`
    create table cg.tenant_config (
      tenant_id uuid not null references cg.tenant(id),
      key text not null,
      value jsonb not null,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      primary key (tenant_id, key)
    )`.execute(db);
  await sql`create trigger tenant_config_touch before update on cg.tenant_config for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.tenant_config')`.execute(db);
  await sql`
    create table cg.tenant_config_history (
      id bigserial primary key,
      tenant_id uuid not null references cg.tenant(id),
      key text not null,
      version integer not null,
      value jsonb not null,
      changed_at timestamptz not null default now(),
      changed_by uuid,
      reason text
    )`.execute(db);
  await sql`create index tenant_config_history_idx on cg.tenant_config_history (tenant_id, key, version)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.tenant_config_history')`.execute(db);
  await sql`
    create or replace function cg.tenant_config_record_history() returns trigger
    language plpgsql as $$
    begin
      insert into cg.tenant_config_history (tenant_id, key, version, value, changed_by)
      values (new.tenant_id, new.key, new.version, new.value, coalesce(new.updated_by, new.created_by));
      return new;
    end $$`.execute(db);
  await sql`create trigger tenant_config_history after insert or update on cg.tenant_config
            for each row execute function cg.tenant_config_record_history()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'tenant_config_history',
    'tenant_config',
    'data_sharing_agreement',
    'license',
    'jurisdiction',
    'tenant',
  ]) {
    await sql`drop table if exists ${sql.table(`cg.${t}`)} cascade`.execute(db);
  }
  for (const f of [
    'tenant_config_record_history()',
    'tenant_set_path()',
    'apply_tenant_rls(regclass)',
    'touch()',
    'is_system()',
    'current_account_id()',
    'current_tenant_path()',
    'visible_tenant_ids()',
    'current_tenant_id()',
  ]) {
    await sql.raw(`drop function if exists cg.${f}`).execute(db);
  }
}
