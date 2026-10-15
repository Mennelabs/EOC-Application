/**
 * 0053 partner counts (decided 2026-10-15; DCL:DEC-09, F15, RULE-10): the
 * declaration view and every official report roll up partner counts, all of
 * them by default or the partner organizations and categories the county
 * chooses. `partner_rollup` holds that choice on the declaration and on each
 * report (an issued report freezes it with its facts).
 *
 * `cg.partner_counts(county, event)` counts from each partner organization's
 * own records, which the county cannot read row by row (tenant isolation):
 * the needs it met, the services its teams logged, the people and households
 * in shelters it runs, and its teams checked in. It returns numbers per
 * organization and category, never a row, a name or a household. It answers
 * only for the county the caller is acting as (or the worker), and only
 * about that county's own partner organizations: for the one aggregate query
 * it adds them to the tenants the row policies let the caller see, then puts
 * the setting back. The API authorizes `declaration.read` or the report's
 * own action before it calls it.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.declaration
    add column partner_rollup jsonb not null default '{"all": true}'::jsonb`.execute(db);
  await sql`alter table cg.official_report
    add column partner_rollup jsonb not null default '{"all": true}'::jsonb`.execute(db);
  for (const t of ['declaration', 'official_report'])
    await sql`alter table ${sql.table(`cg.${t}`)} add constraint ${sql.id(`${t}_partner_rollup_shape`)}
      check (jsonb_typeof(partner_rollup -> 'all') = 'boolean'
        and (partner_rollup -> 'all' = 'true'::jsonb or (
          jsonb_typeof(partner_rollup -> 'partners') = 'array'
          and jsonb_typeof(partner_rollup -> 'categories') = 'array')))`.execute(db);

  await sql`
    create or replace function cg.partner_counts(p_county uuid, p_event uuid)
    returns table (partner_id uuid, organization text, category text, item text, n numeric)
    language plpgsql volatile as $$
    declare
      saved text := coalesce(current_setting('app.tenant_ids', true), '');
      partners text;
    begin
      if not coalesce(cg.is_system() or p_county = cg.current_tenant_id(), false) then
        raise exception 'partner counts answer only for the county itself'
          using errcode = '42501';
      end if;
      select string_agg(t.id::text, ',') into partners
        from cg.tenant t where t.parent_id = p_county and t.kind = 'partner_org';
      if partners is null then
        return;
      end if;
      perform set_config('app.tenant_ids', concat_ws(',', nullif(saved, ''), partners), true);
      return query
        with p as (
          select t.id, t.name from cg.tenant t
          where t.parent_id = p_county and t.kind = 'partner_org'
        )
        select p.id, p.name, 'needs_met'::text, nd.category::text, count(*)::numeric
          from cg.need nd join p on p.id = nd.claimed_by_tenant_id
          where nd.event_id = p_event and nd.status in ('met', 'closed')
          group by 1, 2, 4
        union all
        select p.id, p.name, 'services', s.kind::text, sum(s.count)::numeric
          from cg.service_log s join cg.team tm on tm.id = s.team_id
          join p on p.id = tm.agency_tenant_id
          where s.event_id = p_event
          group by 1, 2, 4
        union all
        select p.id, p.name, 'sheltered', 'households', count(*)::numeric
          from cg.shelter_stay ss join cg.site st on st.id = ss.site_id
          join p on p.id = coalesce(st.operator_tenant_id, st.tenant_id)
          where ss.event_id = p_event
          group by 1, 2
        union all
        select p.id, p.name, 'sheltered', 'people', coalesce(sum(ss.household_size), 0)::numeric
          from cg.shelter_stay ss join cg.site st on st.id = ss.site_id
          join p on p.id = coalesce(st.operator_tenant_id, st.tenant_id)
          where ss.event_id = p_event
          group by 1, 2
        union all
        select p.id, p.name, 'teams', 'checked_in', count(distinct c.team_id)::numeric
          from cg.check_in c join cg.team tm on tm.id = c.team_id
          join p on p.id = tm.agency_tenant_id
          where c.event_id = p_event
          group by 1, 2;
      perform set_config('app.tenant_ids', saved, true);
    end $$`.execute(db);
  await sql`revoke all on function cg.partner_counts(uuid, uuid) from public`.execute(db);
  await sql`grant execute on function cg.partner_counts(uuid, uuid) to cg_app, cg_worker`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists cg.partner_counts(uuid, uuid)`.execute(db);
  for (const t of ['declaration', 'official_report']) {
    await sql`alter table ${sql.table(`cg.${t}`)} drop constraint if exists ${sql.id(`${t}_partner_rollup_shape`)}`.execute(
      db,
    );
    await sql`alter table ${sql.table(`cg.${t}`)} drop column if exists partner_rollup`.execute(db);
  }
}
