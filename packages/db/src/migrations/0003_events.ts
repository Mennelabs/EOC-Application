/**
 * 0003 events (SCL-02): incidents are first-class. Tenants open an event,
 * publish its intake link and keyword, invite participating tenants, and
 * close it. Missions (layer 4) exist only inside an active event (MIS-01).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.event_template (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      hazard_type text not null,
      name text not null,
      config jsonb not null default '{}'::jsonb,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index event_template_tenant_idx on cg.event_template (tenant_id)`.execute(db);
  await sql`create trigger event_template_touch before update on cg.event_template for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.event_template')`.execute(db);

  await sql`
    create table cg.event (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      template_id uuid references cg.event_template(id),
      name text not null,
      hazard_type text not null,
      status text not null default 'draft' check (status in ('draft', 'active', 'closed')),
      intake_slug citext,
      intake_keywords text[] not null default '{}',
      opened_at timestamptz,
      closed_at timestamptz,
      close_reason text,
      footprint geometry(MultiPolygon, 4326),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, intake_slug),
      check ((status = 'closed') = (closed_at is not null)),
      check (status = 'draft' or opened_at is not null)
    )`.execute(db);
  await sql`create index event_tenant_status_idx on cg.event (tenant_id, status)`.execute(db);
  await sql`create index event_footprint_gist on cg.event using gist (footprint)`.execute(db);
  await sql`create trigger event_touch before update on cg.event for each row execute function cg.touch()`.execute(
    db,
  );

  await sql`
    create table cg.event_participant (
      event_id uuid not null references cg.event(id),
      tenant_id uuid not null references cg.tenant(id),
      role text not null default 'partner',
      added_at timestamptz not null default now(),
      added_by uuid,
      primary key (event_id, tenant_id)
    )`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.event_participant')`.execute(db);

  // An event is visible to its owner, to agreement grantees, and to tenants
  // invited as participants (they see the event, not the owner's other records).
  await sql`alter table cg.event enable row level security`.execute(db);
  await sql`alter table cg.event force row level security`.execute(db);
  await sql`
    create policy event_select on cg.event for select using (
      tenant_id = cg.current_tenant_id()
      or tenant_id = any(cg.visible_tenant_ids())
      or exists (select 1 from cg.event_participant p
                 where p.event_id = cg.event.id and p.tenant_id = cg.current_tenant_id())
      or cg.is_system())`.execute(db);
  await sql`
    create policy event_insert on cg.event for insert with check (
      tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(db);
  await sql`
    create policy event_update on cg.event for update
      using (tenant_id = cg.current_tenant_id() or cg.is_system())
      with check (tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(db);
  // No delete policy: events are closed, never deleted.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.event_participant cascade`.execute(db);
  await sql`drop table if exists cg.event cascade`.execute(db);
  await sql`drop table if exists cg.event_template cascade`.execute(db);
}
