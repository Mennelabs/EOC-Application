/**
 * 0109 live conditions (CON-14; layer-8 plan §6). Road closures and work
 * zones, hazards, traffic and utility outages from feeds, each shown with its
 * source and age, and staff entries that override a feed for their area
 * until they lapse.
 *
 * - cg.live_source: a county's feeds: kind (WZDx from a state DOT, the Waze
 *   for Cities partner feed, a utility's outage feed, a file), the address,
 *   whether it is on, how often it is pulled, and how the last pull went.
 *   Pulls reach only hosts the deployment allows; development and CI replay
 *   recorded synthetic responses (ADR-0039, SCL-12). File import stands in
 *   for a feed a county does not have.
 * - cg.live_condition: one item from a feed (unique per source and the
 *   source's own id) or entered by staff (no source; override). Geometry is
 *   a point, line or area on the public road network or a utility area,
 *   never a home. Items lapse by their end time; feed items missing from the
 *   next pull are cleared. Kept with the event under the default retention.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.live_source (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      kind text not null check (kind in ('wzdx', 'waze', 'utility', 'file')),
      name text not null check (char_length(name) between 1 and 120),
      url text check (url is null or (url ~ '^https://' and char_length(url) <= 1000)),
      enabled boolean not null default false,
      refresh_ms integer not null default 300000 check (refresh_ms between 60000 and 86400000),
      last_pulled_at timestamptz,
      last_status text not null default 'never' check (last_status in ('never', 'ok', 'failed')),
      last_error text check (char_length(last_error) <= 500),
      last_count integer,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      check ((kind = 'file') = (url is null))
    );
    create index live_source_tenant_idx on cg.live_source (tenant_id, enabled);
    select cg.apply_tenant_rls('cg.live_source');

    create table cg.live_condition (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      source_id uuid references cg.live_source(id) on delete cascade,
      event_id uuid references cg.event(id),
      kind text not null check (kind in ('road_closure', 'work_zone', 'hazard', 'traffic', 'outage')),
      external_id text check (char_length(external_id) <= 200),
      summary text not null check (char_length(summary) between 1 and 500),
      road text check (char_length(road) <= 200),
      geom geometry(Geometry, 4326)
        check (geom is null or GeometryType(geom) in ('POINT', 'LINESTRING', 'MULTILINESTRING', 'POLYGON', 'MULTIPOLYGON')),
      severity text not null default 'info' check (severity in ('info', 'minor', 'major')),
      starts_at timestamptz,
      ends_at timestamptz,
      as_of timestamptz not null default now(),
      source_ref text check (char_length(source_ref) <= 1000),
      override boolean not null default false,
      entered_by uuid references cg.account(id),
      cleared_at timestamptz,
      cleared_by uuid references cg.account(id),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid references cg.account(id),
      updated_at timestamptz not null default now(),
      updated_by uuid references cg.account(id),
      check ((source_id is null) = override),
      check (source_id is null or external_id is not null),
      unique (source_id, external_id)
    );
    create index live_condition_tenant_idx on cg.live_condition (tenant_id, cleared_at, as_of desc);
    create index live_condition_geom_idx on cg.live_condition using gist (geom);
    select cg.apply_tenant_rls('cg.live_condition');
  `.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists cg.live_condition;
    drop table if exists cg.live_source;
  `.execute(db);
}
