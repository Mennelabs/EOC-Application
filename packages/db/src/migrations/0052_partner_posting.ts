/**
 * 0052 partner self-posting (decided 2026-10-15; PUB-01, PUB-06, CON-16,
 * REC-13): a partner organization posts its own service (a shelter, a
 * feeding site, a POD) and its named approver publishes it to the county's
 * Find help page at once. The site belongs to the county, with the partner
 * as its operator (0039), so one county page lists every service and the
 * county can always edit, close or withdraw it. `posted_by_tenant_id`
 * records which partner posted it; a partner posts only as the site's
 * operator. The partner's writes run in the county's context after the
 * API has authorized them (as the partner's mission and need work does), so
 * no new row policy is needed; the operator's read policy (0039) already
 * lets the partner see the sites it runs.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.site add column posted_by_tenant_id uuid references cg.tenant(id)`.execute(
    db,
  );
  await sql`alter table cg.site add constraint site_posted_by_operator
    check (posted_by_tenant_id is null or posted_by_tenant_id = operator_tenant_id)`.execute(db);
  await sql`create index site_posted_by_idx on cg.site (posted_by_tenant_id)
    where posted_by_tenant_id is not null`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists cg.site_posted_by_idx`.execute(db);
  await sql`alter table cg.site drop constraint if exists site_posted_by_operator`.execute(db);
  await sql`alter table cg.site drop column if exists posted_by_tenant_id`.execute(db);
}
