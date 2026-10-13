/**
 * 0023 sites and ZIP centroids (layer-3 plan §2; CON-09, NED-06, PUB-02–PUB-05,
 * PUB-07/08/09): shelters, feeding stops, PODs, MARCs, cooling and warming
 * centers and reporting tables with every public field, a confirmation window,
 * a confidential flag that keeps a site out of every public output, and the
 * published version. ZIP centroids make "nearest" work without the geocoder
 * (SCL-06). Every column is in the dictionary (SEC-11).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.site (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid references cg.event(id),
      kind text not null check (kind in ('shelter', 'feeding', 'pod', 'marc', 'cooling', 'warming', 'reporting', 'charging', 'other')),
      name text not null,
      slug text not null,
      location_id uuid references cg.location(id),
      status text not null default 'planned' check (status in ('planned', 'open', 'limited', 'full', 'closed')),
      capacity integer check (capacity >= 0),
      occupancy integer check (occupancy >= 0),
      hours jsonb not null default '{}'::jsonb,
      services text[] not null default '{}',
      pets text not null default 'unknown' check (pets in ('yes', 'no', 'service_animals', 'unknown')),
      accessibility jsonb not null default '{}'::jsonb,
      medical_power boolean,
      languages text[] not null default '{}',
      transit text,
      directions text,
      notes text,
      confidential boolean not null default false,
      lead_contact_id uuid references cg.partner_contact(id),
      confirm_every_hours integer not null default 12 check (confirm_every_hours between 1 and 168),
      last_confirmed_at timestamptz,
      last_confirmed_by uuid,
      published_version integer,
      published_at timestamptz,
      unpublished_at timestamptz,
      usng text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, slug)
    )`.execute(db);
  await sql`create index site_public_idx on cg.site (tenant_id, status, confidential, published_at)`.execute(
    db,
  );
  await sql`create index site_event_idx on cg.site (event_id)`.execute(db);
  await sql`create trigger site_touch before update on cg.site for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.site')`.execute(db);

  await sql`
    create table cg.zip_centroid (
      tenant_id uuid not null references cg.tenant(id),
      postal text not null,
      name text,
      geom geometry(Point, 4326) not null,
      primary key (tenant_id, postal)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.zip_centroid')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.zip_centroid cascade`.execute(db);
  await sql`drop table if exists cg.site cascade`.execute(db);
}
