/**
 * 0017 public tenant lookup by slug (CHN-08, BRD:FR-18.02): public intake
 * routes name the tenant in the URL before any tenant context exists. The
 * select policy on cg.tenant gains one clause: the row whose slug equals the
 * transaction-local setting `app.public_slug`. Nothing else becomes visible;
 * the API returns only public branding fields from that row.
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function cg.public_slug() returns text
    language sql stable as $$
      select nullif(current_setting('app.public_slug', true), '')
    $$`.execute(db);
  await sql`drop policy tenant_select on cg.tenant`.execute(db);
  await sql`
    create policy tenant_select on cg.tenant for select using (
      id = cg.current_tenant_id()
      or id = any(cg.visible_tenant_ids())
      or (cg.current_tenant_path() is not null and path <@ cg.current_tenant_path())
      or (cg.public_slug() is not null and slug = cg.public_slug())
      or cg.is_system())`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy tenant_select on cg.tenant`.execute(db);
  await sql`
    create policy tenant_select on cg.tenant for select using (
      id = cg.current_tenant_id()
      or id = any(cg.visible_tenant_ids())
      or (cg.current_tenant_path() is not null and path <@ cg.current_tenant_path())
      or cg.is_system())`.execute(db);
  await sql`drop function if exists cg.public_slug()`.execute(db);
}
