/**
 * 0104 offline map packages (FLD-13 "before deployment, the app downloads
 * maps … for the volunteer's area", SCL-13, ADR-0015). One row per area of
 * a county's parcels: the box the package covers, how many tiles and bytes
 * it holds, its hash (the phone checks its download against it), the object
 * it is stored as, and which build of the regional tiles it was cut from. The
 * worker cuts a package again only when the region's tiles or the area's lots
 * change. Nothing in it is about a person.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.map_package (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      area_key text not null check (length(area_key) between 1 and 120),
      min_lon double precision not null,
      min_lat double precision not null,
      max_lon double precision not null,
      max_lat double precision not null,
      min_zoom smallint not null,
      max_zoom smallint not null,
      tiles integer not null check (tiles >= 0),
      bytes integer not null check (bytes > 0),
      sha256 text not null,
      object_key text not null,
      region_stamp text not null,
      cut_at timestamptz not null default now(),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, area_key)
    )`.execute(db);
  await sql`create trigger map_package_touch before update on cg.map_package
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.map_package')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.map_package`.execute(db);
  await loadDictionary(db);
}
