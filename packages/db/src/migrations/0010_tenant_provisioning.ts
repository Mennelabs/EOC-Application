/**
 * 0010 tenant provisioning: a new tenant starts as 'provisioning' and the
 * worker (system role) seeds its retention defaults, template roles and
 * identity realm before it becomes 'active' (architecture §4.1, ADR-0007).
 */
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.tenant drop constraint tenant_status_check`.execute(db);
  await sql`alter table cg.tenant add constraint tenant_status_check
            check (status in ('provisioning', 'active', 'suspended', 'closed'))`.execute(db);
  await sql`alter table cg.tenant alter column status set default 'provisioning'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update cg.tenant set status = 'active' where status = 'provisioning'`.execute(db);
  await sql`alter table cg.tenant drop constraint tenant_status_check`.execute(db);
  await sql`alter table cg.tenant add constraint tenant_status_check
            check (status in ('active', 'suspended', 'closed'))`.execute(db);
  await sql`alter table cg.tenant alter column status set default 'active'`.execute(db);
}
