/**
 * 0092 equipment used on a work order (FL:FR-19): a cleanup or road crew
 * logs which equipment ran on a mission and for how many hours on which day
 * (a chainsaw, a pump, a generator, a skid steer and the like), the hours
 * FEMA Public Assistance asks for equipment. Hours worked by people come
 * from check-in. A field record: the phone's id makes a resend harmless, and
 * the retention sweep removes it with the other field records once its
 * event has closed for the period (SEC-13); only the worker role passes
 * `cg.is_system()` for that delete.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.equipment_use (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      mission_id uuid not null references cg.mission(id),
      client_uuid uuid not null,
      equipment text not null check (equipment in ('chainsaw', 'pump', 'generator', 'skid_steer',
        'dump_truck', 'chipper', 'pressure_washer', 'dehumidifier', 'other')),
      equipment_note text,
      hours numeric(5, 2) not null check (hours > 0 and hours <= 24),
      used_on date not null default current_date,
      reported_by uuid,
      reported_personnel_id uuid references cg.personnel(id),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid)
    )`.execute(db);
  await sql`create index equipment_use_mission_idx on cg.equipment_use (tenant_id, mission_id, used_on)`.execute(
    db,
  );
  await sql`create trigger equipment_use_touch before update on cg.equipment_use for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.equipment_use')`.execute(db);
  await sql`drop policy tenant_delete on cg.equipment_use`.execute(db);
  await sql`create policy retention_delete on cg.equipment_use for delete using (cg.is_system())`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.equipment_use`.execute(db);
  await loadDictionary(db);
}
