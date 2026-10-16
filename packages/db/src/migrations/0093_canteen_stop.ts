/**
 * 0093 canteen stops (FL:FR-17): a feeding or canteen crew checks in at a
 * stop on its route and checks out when it leaves, with how many meals it
 * served there, what supplies are left on the truck and an allergen note.
 * The note is about the food (what it contains, how many asked for a
 * special diet), never about who has an allergy (plan reading 27). The
 * check-out names the check-in by the phone's id, so both work without
 * signal. A field record: deleted by the worker role with the other field
 * records once its event has closed for the period (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.canteen_stop (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      mission_id uuid references cg.mission(id),
      client_uuid uuid not null,
      stop_name text not null,
      geom geometry(Point, 4326),
      arrived_at timestamptz not null default now(),
      departed_at timestamptz,
      meals_served integer check (meals_served is null or meals_served between 0 and 100000),
      supplies_left text,
      allergen_note text,
      reported_by uuid,
      reported_personnel_id uuid references cg.personnel(id),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid),
      check (departed_at is null or departed_at >= arrived_at)
    )`.execute(db);
  await sql`create index canteen_stop_event_idx on cg.canteen_stop (tenant_id, event_id, arrived_at desc)`.execute(
    db,
  );
  await sql`create trigger canteen_stop_touch before update on cg.canteen_stop for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.canteen_stop')`.execute(db);
  await sql`drop policy tenant_delete on cg.canteen_stop`.execute(db);
  await sql`create policy retention_delete on cg.canteen_stop for delete using (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.canteen_stop`.execute(db);
  await loadDictionary(db);
}
