/**
 * 0043 location geography (layer-6 plan §4, task C; DCL:DEC-05, EQ-11,
 * CON-07, RULE-10): which census tract and which jurisdiction each located
 * place falls in, so damage, needs and coverage add up by tract and by
 * city. The worker keeps it current: when a location gets coordinates, and
 * when a new tract snapshot becomes current (the row names the tract
 * snapshot it was assigned from, so a report can cite it). Written only by
 * the system; staff read their own tenant's. A tract is an area of a few
 * thousand people, not a home, so the assignment is internal, not
 * restricted (the exact location stays in `location`).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';
import { systemWritten } from './0042_reference_data.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.location_geo (
      location_id uuid primary key references cg.location(id) on delete cascade,
      tenant_id uuid not null references cg.tenant(id),
      tract_geoid text check (tract_geoid ~ '^[0-9]{11}$'),
      tract_snapshot_id uuid references cg.refdata_snapshot(id) on delete set null,
      jurisdiction_tenant_id uuid references cg.tenant(id),
      assigned_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index location_geo_tract_idx on cg.location_geo (tenant_id, tract_geoid)`.execute(
    db,
  );
  await sql`create index location_geo_snapshot_idx on cg.location_geo (tract_snapshot_id)`.execute(
    db,
  );
  await systemWritten(db, 'location_geo');
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.location_geo`.execute(db);
  await loadDictionary(db);
}
