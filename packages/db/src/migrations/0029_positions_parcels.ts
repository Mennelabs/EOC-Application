/**
 * 0029 positions and parcels (layer-4 plan §2, task A; DSP-08, SEC-13, FLD-04,
 * FLD-05, BRD:FR-03.01–03.03): live positions in daily partitions so a whole
 * day drops at once when the tenant's position-trail period ends (30 days by
 * default), and the tenant's parcel data the field app snaps a GPS pin to.
 * Positions tied to an incident record are copied onto it (layer-4 B) and
 * stay with the record; this table is only the trail. Every column is in the
 * dictionary (SEC-11); partitions carry the parent's row-level security.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

/** The dictionary check names tables, never their partitions (a partition has the parent's columns). */
const UNDOCUMENTED_COLUMNS = (withPartitions: boolean) => `
    create or replace function cg.undocumented_columns()
    returns table (table_name text, column_name text)
    language sql stable as $$
      select c.table_name::text, c.column_name::text
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      join pg_class r on r.relname = c.table_name
      join pg_namespace n on n.oid = r.relnamespace and n.nspname = c.table_schema
      where c.table_schema = 'cg'
        and t.table_type = 'BASE TABLE'
        ${withPartitions ? '' : 'and not r.relispartition'}
        and not exists (
          select 1 from cg.data_dictionary d
          where d.table_name = c.table_name and d.column_name = c.column_name)
      order by 1, 2
    $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.position (
      id uuid not null default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      check_in_id uuid not null,
      personnel_id uuid not null,
      team_id uuid,
      geom geometry(Point, 4326) not null,
      accuracy_m real check (accuracy_m >= 0),
      speed_mps real check (speed_mps >= 0),
      heading real check (heading between 0 and 360),
      source text not null check (source in ('app', 'net_control', 'manual', 'help_alert')),
      recorded_at timestamptz not null,
      received_at timestamptz not null default now(),
      primary key (id, recorded_at)
    ) partition by range (recorded_at)`.execute(db);
  await sql`create index position_check_in_idx on cg.position (check_in_id, recorded_at desc)`.execute(
    db,
  );
  await sql`create index position_team_idx on cg.position (tenant_id, team_id, recorded_at desc)`.execute(
    db,
  );
  await sql`create index position_geom_idx on cg.position using gist (geom)`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.position')`.execute(db);
  await sql`drop policy tenant_update on cg.position`.execute(db);

  // One partition per UTC day, named cg.position_p_YYYYMMDD, with the same row-level
  // security as the parent for direct access (SEC-05). The worker keeps a few days ahead
  // so an insert never meets a missing partition (SCL-06).
  await sql`
    create or replace function cg.ensure_position_partition(p_day date)
    returns text language plpgsql security definer set search_path = cg, public as $$
    declare
      part text := 'position_p_' || to_char(p_day, 'YYYYMMDD');
    begin
      if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'cg' and c.relname = part) then
        return null;
      end if;
      -- Bounds in UTC whatever the session time zone: a day is the same day on every connection.
      execute format('create table cg.%I partition of cg.position for values from (%L) to (%L)',
                     part, p_day::timestamp at time zone 'UTC', (p_day + 1)::timestamp at time zone 'UTC');
      execute format('select cg.apply_tenant_rls(%L)', 'cg.' || part);
      execute format('drop policy tenant_update on cg.%I', part);
      return part;
    end $$`.execute(db);
  await sql`
    create or replace function cg.ensure_position_partitions(p_days_ahead integer default 3, p_days_back integer default 1)
    returns setof text language plpgsql security definer set search_path = cg, public as $$
    declare
      today date := (now() at time zone 'UTC')::date;
      d date;
      part text;
    begin
      for d in select generate_series(today - p_days_back, today + p_days_ahead, interval '1 day')::date loop
        part := cg.ensure_position_partition(d);
        if part is not null then
          return next part;
        end if;
      end loop;
      return;
    end $$`.execute(db);

  // Drops every partition whose day ended before now() - p_keep (DSP-08, SEC-13) and
  // names them; the caller counts what leaves (as the system role) for cg.deletion_log,
  // since row-level security is forced on the owner this function runs as.
  await sql`
    create or replace function cg.drop_position_partitions(p_keep interval)
    returns table (partition_name text, day date) language plpgsql security definer set search_path = cg, public as $$
    declare
      r record;
    begin
      for r in
        select c.relname, to_date(substr(c.relname, 12), 'YYYYMMDD') as day
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
        join pg_namespace ns on ns.oid = p.relnamespace
        where ns.nspname = 'cg' and p.relname = 'position'
      loop
        if ((r.day + 1)::timestamp at time zone 'UTC') < now() - p_keep then
          execute format('drop table cg.%I', r.relname);
          partition_name := r.relname; day := r.day;
          return next;
        end if;
      end loop;
      return;
    end $$`.execute(db);
  await sql`select cg.ensure_position_partitions(3, 1)`.execute(db);

  // Tenant parcel data (FLD-04): outline, address of record and structure type, loaded
  // from the county's parcel file; the seed's grid for the exercise (SCL-12).
  await sql`
    create table cg.parcel (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      parcel_id text not null,
      geom geometry(Geometry, 4326) not null check (GeometryType(geom) in ('POLYGON', 'MULTIPOLYGON')),
      centroid geometry(Point, 4326) generated always as (ST_Centroid(geom)) stored,
      line1 text,
      city text,
      postal text,
      structure text not null default 'other' check (structure in ('single_family', 'manufactured', 'apartment_building', 'commercial', 'public', 'vacant', 'other')),
      unit_count integer check (unit_count >= 0),
      area_key text,
      source text not null default 'import',
      loaded_at timestamptz not null default now(),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, parcel_id)
    )`.execute(db);
  await sql`create index parcel_geom_idx on cg.parcel using gist (geom)`.execute(db);
  await sql`create index parcel_centroid_idx on cg.parcel using gist (centroid)`.execute(db);
  await sql`create index parcel_area_idx on cg.parcel (tenant_id, area_key)`.execute(db);
  await sql`create trigger parcel_touch before update on cg.parcel for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.parcel')`.execute(db);

  await sql.raw(UNDOCUMENTED_COLUMNS(false)).execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.parcel cascade`.execute(db);
  await sql`drop function if exists cg.drop_position_partitions(interval)`.execute(db);
  await sql`drop function if exists cg.ensure_position_partitions(integer, integer)`.execute(db);
  await sql`drop function if exists cg.ensure_position_partition(date)`.execute(db);
  await sql`drop table if exists cg.position cascade`.execute(db);
  await sql.raw(UNDOCUMENTED_COLUMNS(true)).execute(db);
}
