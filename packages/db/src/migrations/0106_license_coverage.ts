/**
 * 0106 subscription coverage (SCL-10 "each contract is an annual
 * subscription per jurisdiction, tiered by population served. Store tier,
 * term and covered jurisdictions per tenant; a state or coalition contract
 * can cover member jurisdictions. Never meter or cap resident reports").
 *
 * - A contract covers only member jurisdictions: tenants below its holder in
 *   the hierarchy, each once. A county cannot be put on another state's
 *   contract by a typo.
 * - `cg.license_coverage()` answers, for the acting tenant only, which
 *   contracts are its own and which of its ancestors' contracts cover it.
 *   The ancestor's row is otherwise invisible to the county (forced RLS), so
 *   the function widens what the transaction may read to the ancestors for
 *   the one query and puts it back. Of a covering contract the county learns
 *   the holder, tier, term and status, and which of its own subtree it
 *   covers; never the other jurisdictions on it (only how many).
 * - Nothing here is read by intake: a missing, expired or cancelled contract
 *   never stops a resident report (tested in license.db.test.ts).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function cg.license_covers_check() returns trigger
    language plpgsql as $$
    declare
      holder ltree;
      bad uuid;
    begin
      if cardinality(new.covers_tenant_ids) <> (select count(distinct x) from unnest(new.covers_tenant_ids) x) then
        raise exception 'a contract lists each covered jurisdiction once' using errcode = '23514';
      end if;
      select t.path into holder from cg.tenant t where t.id = new.tenant_id;
      select x into bad from unnest(new.covers_tenant_ids) x
        where not exists (
          select 1 from cg.tenant c where c.id = x and c.id <> new.tenant_id and c.path <@ holder)
        limit 1;
      if bad is not null then
        raise exception 'a contract covers only member jurisdictions of its holder (%)', bad
          using errcode = '23514';
      end if;
      return new;
    end $$`.execute(db);
  await sql`
    create trigger license_covers_check before insert or update of covers_tenant_ids, tenant_id
    on cg.license for each row execute function cg.license_covers_check()`.execute(db);

  await sql`
    create or replace function cg.license_coverage()
    returns table (
      id uuid, holder_id uuid, holder_name text, holder_kind text, tier text,
      population_served integer, term_start date, term_end date, status text,
      in_force boolean, covered jsonb, covered_count integer)
    language plpgsql volatile as $$
    #variable_conflict use_column
    declare
      me uuid := cg.current_tenant_id();
      saved text := coalesce(current_setting('app.tenant_ids', true), '');
      my_path ltree;
      my_zone text;
      ancestors uuid[];
    begin
      if me is null then
        raise exception 'subscription coverage answers only for a tenant' using errcode = '42501';
      end if;
      select t.path, t.timezone into my_path, my_zone from cg.tenant t where t.id = me;
      if my_path is null then
        raise exception 'subscription coverage answers only for a tenant' using errcode = '42501';
      end if;
      select coalesce(array_agg(replace(label, '_', '-')::uuid), '{}') into ancestors
        from unnest(string_to_array(my_path::text, '.')) label
        where replace(label, '_', '-')::uuid <> me;
      perform set_config('app.tenant_ids',
        concat_ws(',', nullif(saved, ''), nullif(array_to_string(ancestors, ','), '')), true);
      return query
        select l.id, l.tenant_id, h.name::text, h.kind::text, l.tier, l.population_served,
               l.term_start, l.term_end, l.status::text,
               l.status = 'active'
                 and (now() at time zone my_zone)::date between l.term_start and l.term_end,
               (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                                          order by c.name), '[]'::jsonb)
                  from cg.tenant c
                  where c.id = any(l.covers_tenant_ids) and c.path <@ my_path),
               cardinality(l.covers_tenant_ids)
          from cg.license l join cg.tenant h on h.id = l.tenant_id
          where l.tenant_id = me
             or (l.tenant_id = any(ancestors) and me = any(l.covers_tenant_ids))
          order by l.term_end desc, l.term_start desc;
      perform set_config('app.tenant_ids', saved, true);
    end $$`.execute(db);
  await sql`revoke all on function cg.license_coverage() from public`.execute(db);
  await sql`grant execute on function cg.license_coverage() to cg_app, cg_worker`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists cg.license_coverage()`.execute(db);
  await sql`drop trigger if exists license_covers_check on cg.license`.execute(db);
  await sql`drop function if exists cg.license_covers_check()`.execute(db);
}
