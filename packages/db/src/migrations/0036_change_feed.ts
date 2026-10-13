/**
 * 0036 change feed triggers (layer-4 plan §3 and §5, task F; NFR-07, FLD-13,
 * FLD-14, DSP-01, ADR-0022): every write to a record the board or the field
 * app follows leaves a row in `cg.change_feed` naming the record's type, id
 * and version and the scope it belongs to (the person or team it concerns,
 * the event, or the tenant). The live stream and the field sync read the
 * feed; they carry no record data, so a client always refetches through the
 * authorized API (SEC-05). An ancestor tenant (the county board) reads its
 * partners' feed rows as it reads their roster (0035), and a status fact an
 * ancestor records about a partner's team may leave its feed row. Positions
 * are not triggered (one row per batch is written by the route instead).
 * No columns change.
 */
import { sql, type Kysely } from 'kysely';

/** table → scope kind and the column that names the scope (null = tenant-wide). */
export const FEED_TABLES: readonly { table: string; scope: string; column: string | null }[] = [
  { table: 'mission', scope: 'event', column: 'event_id' },
  { table: 'assignment', scope: 'resource', column: null }, // person or team, from the row
  { table: 'team', scope: 'team', column: 'id' },
  { table: 'team_status', scope: 'team', column: 'team_id' },
  { table: 'check_in', scope: 'team', column: 'team_id' },
  { table: 'hazard', scope: 'event', column: 'event_id' },
  { table: 'field_message', scope: 'event', column: 'event_id' },
  { table: 'field_message_receipt', scope: 'person', column: 'personnel_id' },
  { table: 'safety_alert', scope: 'event', column: 'event_id' },
  { table: 'reminder', scope: 'tenant', column: null },
  { table: 'field_device', scope: 'tenant', column: null },
  { table: 'site', scope: 'event', column: 'event_id' },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function cg.feed_change() returns trigger
    language plpgsql as $$
    declare
      row_json jsonb := to_jsonb(new);
      scope_kind text := tg_argv[0];
      scope_col text := nullif(tg_argv[1], '');
      scope_id uuid := null;
      ver integer := null;
    begin
      if scope_kind = 'resource' then
        if row_json->>'resource_kind' = 'team' then
          scope_kind := 'team'; scope_id := (row_json->>'team_id')::uuid;
        else
          scope_kind := 'person'; scope_id := (row_json->>'personnel_id')::uuid;
        end if;
      elsif scope_col is not null then
        scope_id := (row_json->>scope_col)::uuid;
        if scope_id is null then scope_kind := 'tenant'; end if;
      end if;
      if row_json ? 'version' then ver := (row_json->>'version')::integer; end if;
      insert into cg.change_feed (tenant_id, scope_kind, scope_id, record_type, record_id, record_version, op)
      values (new.tenant_id, scope_kind, scope_id, tg_table_name, new.id, ver, 'upsert');
      return null;
    end $$`.execute(db);
  for (const t of FEED_TABLES) {
    await sql
      .raw(
        `create trigger ${t.table}_feed after insert or update on cg.${t.table}
         for each row execute function cg.feed_change('${t.scope}', '${t.column ?? ''}')`,
      )
      .execute(db);
  }
  // The county's board follows its partners' changes (DSP-09, 0035), and a fact an
  // ancestor records about a partner's team (team_status insert, 0035) leaves its feed row.
  await sql`select cg.apply_subtree_select('cg.change_feed')`.execute(db);
  await sql`drop policy tenant_insert on cg.change_feed`.execute(db);
  await sql`
    create policy tenant_insert on cg.change_feed for insert with check (
      tenant_id = cg.current_tenant_id()
      or cg.is_system()
      or (cg.current_tenant_path() is not null and exists (
        select 1 from cg.tenant t where t.id = tenant_id and t.path <@ cg.current_tenant_path())))`.execute(
    db,
  );
  // The relay publishes feed rows to the fan-out exchange in order (ADR-0022).
  await sql`create index change_feed_seq_idx on cg.change_feed (seq) include (tenant_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of FEED_TABLES) {
    await sql.raw(`drop trigger if exists ${t.table}_feed on cg.${t.table}`).execute(db);
  }
  await sql`drop function if exists cg.feed_change()`.execute(db);
  await sql`drop index if exists cg.change_feed_seq_idx`.execute(db);
  await sql`drop policy tenant_insert on cg.change_feed`.execute(db);
  await sql`create policy tenant_insert on cg.change_feed for insert with check (tenant_id = cg.current_tenant_id() or cg.is_system())`.execute(
    db,
  );
  await sql`drop policy if exists tenant_select on cg.change_feed`.execute(db);
  await sql`
    create policy tenant_select on cg.change_feed for select using (
      tenant_id = cg.current_tenant_id() or tenant_id = any(cg.visible_tenant_ids()) or cg.is_system())`.execute(
    db,
  );
}
