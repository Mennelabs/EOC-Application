/**
 * 0039 site operator (layer-4 task K; CON-16, FL:FR-14, FLD-12, ADM-05,
 * SEC-05): a county-owned shelter, feeding site or POD is often run by a
 * partner organization (Red Cross, Salvation Army). The site now names that
 * operator, and the operator's staff may read the site and record its
 * status and census; everything else about the site stays with its owner.
 * Row security grants the operator exactly that (select and update on the
 * site row, and the change-feed row the update leaves); the API limits the
 * update to confirmation (site.confirm). The operator's shelter
 * registrations stay in the operator's own tenant: the county sees the
 * census the operator confirms on the site, not the households (the reading
 * that protects guests' privacy; flagged for Adam in the layer-4 status).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.site add column operator_tenant_id uuid references cg.tenant(id)`.execute(
    db,
  );
  await sql`create index site_operator_idx on cg.site (operator_tenant_id) where operator_tenant_id is not null`.execute(
    db,
  );
  await sql`create policy site_operator_select on cg.site for select using (
    operator_tenant_id is not null and operator_tenant_id = cg.current_tenant_id())`.execute(db);
  await sql`create policy site_operator_update on cg.site for update
    using (operator_tenant_id is not null and operator_tenant_id = cg.current_tenant_id())
    with check (operator_tenant_id is not null and operator_tenant_id = cg.current_tenant_id())`.execute(
    db,
  );
  // The site's change-feed row belongs to the owning county; the operator may leave it.
  await sql`create policy site_operator_feed on cg.change_feed for insert with check (
    record_type = 'site' and exists (
      select 1 from cg.site s where s.id = record_id
        and s.operator_tenant_id is not null and s.operator_tenant_id = cg.current_tenant_id()))`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists site_operator_feed on cg.change_feed`.execute(db);
  await sql`drop policy if exists site_operator_update on cg.site`.execute(db);
  await sql`drop policy if exists site_operator_select on cg.site`.execute(db);
  await sql`drop index if exists cg.site_operator_idx`.execute(db);
  await sql`alter table cg.site drop column if exists operator_tenant_id`.execute(db);
}
