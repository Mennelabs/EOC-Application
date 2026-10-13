/**
 * 0035 roster visibility (layer-4 plan §6.7, task C; DSP-09, CON-15, SEC-05):
 * "each agency's dispatchers see and assign their own people; the county
 * coordinator sees everyone". The roster tables (personnel, credentials,
 * teams, members, status, check-ins, devices) and live positions become
 * readable by an ancestor tenant through the same subtree rule `cg.tenant`
 * already uses (`path <@ cg.current_tenant_path()`); a descendant still sees
 * nothing of its parent, and writes stay with the owning tenant except a
 * status fact an ancestor's board or net control records about a
 * descendant's team. The policy engine still requires the action grant
 * (`team.read`, `position.read`, …) on top of this. No columns change.
 */
import { sql, type Kysely } from 'kysely';

export const ROSTER_TABLES = [
  'cg.personnel',
  'cg.credential',
  'cg.team',
  'cg.team_member',
  'cg.team_status',
  'cg.check_in',
  'cg.field_device',
  'cg.position',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function cg.apply_subtree_select(tbl regclass) returns void
    language plpgsql as $$
    begin
      execute format('drop policy if exists tenant_select on %s', tbl);
      execute format($p$create policy tenant_select on %s for select using (
        tenant_id = cg.current_tenant_id()
        or tenant_id = any(cg.visible_tenant_ids())
        or cg.is_system()
        or (cg.current_tenant_path() is not null and exists (
          select 1 from cg.tenant t where t.id = tenant_id and t.path <@ cg.current_tenant_path())))$p$, tbl);
    end $$`.execute(db);
  for (const t of ROSTER_TABLES) {
    await sql.raw(`select cg.apply_subtree_select('${t}')`).execute(db);
  }
  // Existing position partitions, and every partition created from now on (0029's function).
  const partitions = await sql<{ relname: string }>`
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'cg' and p.relname = 'position'`.execute(db);
  for (const { relname } of partitions.rows) {
    await sql.raw(`select cg.apply_subtree_select('cg.${relname}')`).execute(db);
  }
  await sql`
    create or replace function cg.ensure_position_partition(p_day date)
    returns text language plpgsql as $$
    declare
      part text := 'position_p_' || to_char(p_day, 'YYYYMMDD');
    begin
      if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'cg' and c.relname = part) then
        return null;
      end if;
      execute format('create table cg.%I partition of cg.position for values from (%L) to (%L)',
                     part, p_day::timestamp at time zone 'UTC', (p_day + 1)::timestamp at time zone 'UTC');
      execute format('select cg.apply_tenant_rls(%L)', 'cg.' || part);
      execute format('drop policy tenant_update on cg.%I', part);
      execute format('select cg.apply_subtree_select(%L)', 'cg.' || part);
      return part;
    end $$`.execute(db);
  // An ancestor's board or net control may record a status fact about a descendant's team (DSP-10).
  await sql`drop policy tenant_insert on cg.team_status`.execute(db);
  await sql`
    create policy tenant_insert on cg.team_status for insert with check (
      tenant_id = cg.current_tenant_id()
      or cg.is_system()
      or (cg.current_tenant_path() is not null and exists (
        select 1 from cg.tenant t where t.id = tenant_id and t.path <@ cg.current_tenant_path())))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const own = (tbl: string) => `
    drop policy if exists tenant_select on ${tbl};
    create policy tenant_select on ${tbl} for select using (
      tenant_id = cg.current_tenant_id() or tenant_id = any(cg.visible_tenant_ids()) or cg.is_system())`;
  for (const t of ROSTER_TABLES) await sql.raw(own(t)).execute(db);
  const partitions = await sql<{ relname: string }>`
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'cg' and p.relname = 'position'`.execute(db);
  for (const { relname } of partitions.rows) await sql.raw(own(`cg.${relname}`)).execute(db);
  await sql`drop policy tenant_insert on cg.team_status`.execute(db);
  await sql`create policy tenant_insert on cg.team_status for insert with check (tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(
    db,
  );
  await sql`
    create or replace function cg.ensure_position_partition(p_day date)
    returns text language plpgsql as $$
    declare
      part text := 'position_p_' || to_char(p_day, 'YYYYMMDD');
    begin
      if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'cg' and c.relname = part) then
        return null;
      end if;
      execute format('create table cg.%I partition of cg.position for values from (%L) to (%L)',
                     part, p_day::timestamp at time zone 'UTC', (p_day + 1)::timestamp at time zone 'UTC');
      execute format('select cg.apply_tenant_rls(%L)', 'cg.' || part);
      execute format('drop policy tenant_update on cg.%I', part);
      return part;
    end $$`.execute(db);
  await sql`drop function if exists cg.apply_subtree_select(regclass)`.execute(db);
}
