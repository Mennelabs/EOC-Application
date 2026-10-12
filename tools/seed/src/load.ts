/**
 * Loads the synthetic WESTWIND county into a running stack (SCL-12, docs/02):
 * tenant hierarchy, template roles, the console cast as staff accounts with
 * role assignments, and provisioning messages for the worker (identity
 * realms, invitations). Runs as the cg_worker role; idempotent by slug/email.
 *
 *   DATABASE_URL=postgres://cg_worker:...@localhost:5432/cg node tools/seed/src/load.ts
 *
 * Staff accounts get the synthetic password below in development so the
 * exercise can be driven without email round-trips; the passkey is still
 * required on first browser login (SEC-07).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withTenant, type Database } from '@cg/db';
import { ensureRetentionDefaults, ensureTemplateRoles } from '@cg/provisioning';
import type { Kysely, Transaction } from 'kysely';
import { tenants as tenantSpecs } from './county.ts';

export const DEV_PASSWORD = 'Westwind-Exercise-2026!';
/** Fixed ids so re-runs and tests can refer to the seed actors. */
export const SEED_ACTOR_A = '01900000-5eed-4000-8000-00000000000a';
export const SEED_ACTOR_B = '01900000-5eed-4000-8000-00000000000b';

/** The WESTWIND cast (docs/02) and which template each holds. */
export const cast = [
  {
    email: 'dana.director@example.org',
    name: 'Dana Rivera',
    role: 'county_em_director',
    tenant: 'county',
  },
  {
    email: 'security.admin@example.org',
    name: 'Sam Okafor',
    role: 'security_admin',
    tenant: 'county',
  },
  { email: 'admin@example.org', name: 'Jordan Lindqvist', role: 'tenant_admin', tenant: 'county' },
  {
    email: 'marcus.gis@example.org',
    name: 'Marcus Haddad',
    role: 'planning_gis_lead',
    tenant: 'county',
  },
  {
    email: 'priya.assessment@example.org',
    name: 'Priya Nguyen',
    role: 'damage_assessment_coordinator',
    tenant: 'county',
  },
  {
    email: 'luis.masscare@example.org',
    name: 'Luis Castillo',
    role: 'mass_care_coordinator',
    tenant: 'county',
  },
  {
    email: 'keisha.afn@example.org',
    name: 'Keisha Brennan',
    role: 'afn_coordinator',
    tenant: 'county',
  },
  {
    email: 'tomas.pio@example.org',
    name: 'Tomás Moreau',
    role: 'public_information_officer',
    tenant: 'county',
  },
  { email: 'jen.coad@example.org', name: 'Jen Kowalski', role: 'coad_chair', tenant: 'coad' },
  {
    email: 'ruth.canteen@example.org',
    name: 'Ruth Adeyemi',
    role: 'ngo_incident_commander',
    tenant: 'canteen',
  },
  {
    email: 'state.liaison@example.org',
    name: 'Alex Fairbank',
    role: 'state_liaison',
    tenant: 'state',
  },
  { email: 'nurse@example.org', name: 'Mei Delgado', role: 'shelter_nurse', tenant: 'shelter-ngo' },
] as const;

interface Loaded {
  tenants: Record<string, string>;
  accounts: Record<string, string>;
}

async function ensureTenant(
  db: Kysely<Database>,
  spec: (typeof tenantSpecs)[number],
  parentId: string | null,
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .selectFrom('cg.tenant')
    .select('id')
    .where('slug', '=', spec.key)
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const row = await db
    .insertInto('cg.tenant')
    .values({
      kind: spec.kind,
      parent_id: parentId,
      slug: spec.key,
      name: spec.name,
      timezone: spec.timezone,
      locales: spec.locales,
      status: 'provisioning',
      security_contact_email: `security+${spec.key}@example.org`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, created: true };
}

async function ensureAccount(
  trx: Transaction<Database>,
  tenantId: string,
  member: (typeof cast)[number],
  roleId: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await trx
    .selectFrom('cg.account')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', member.email)
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const account = await trx
    .insertInto('cg.account')
    .values({
      tenant_id: tenantId,
      email: member.email,
      display_name: member.name,
      status: 'active',
      activated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('cg.account_lifecycle')
    .values({
      tenant_id: tenantId,
      account_id: account.id,
      from_status: null,
      to_status: 'active',
      reason: 'seed',
      actor_account_id: null,
    })
    .execute();
  await trx
    .insertInto('cg.role_assignment')
    .values({
      tenant_id: tenantId,
      account_id: account.id,
      role_id: roleId,
      scope: '{}',
      granted_by: SEED_ACTOR_A,
      approved_by: SEED_ACTOR_B,
      created_by: SEED_ACTOR_A,
      updated_by: SEED_ACTOR_B,
    })
    .execute();
  await trx
    .insertInto('cg.outbox')
    .values({
      tenant_id: tenantId,
      topic: 'account.invited',
      payload: JSON.stringify({ accountId: account.id, devPassword: DEV_PASSWORD }),
      execution_id: randomUUID(),
    })
    .execute();
  return { id: account.id, created: true };
}

export async function loadSeed(db: Kysely<Database>): Promise<Loaded> {
  const tenantIds: Record<string, string> = {};
  const accountIds: Record<string, string> = {};

  // Hierarchy in dependency order (parents first, as listed in county.ts).
  for (const spec of tenantSpecs) {
    const parentId = spec.parent ? (tenantIds[spec.parent] ?? null) : null;
    const { id, created } = await ensureTenant(db, spec, parentId);
    tenantIds[spec.key] = id;
    await withTenant(db, { tenantId: id }, async (trx) => {
      await ensureRetentionDefaults(trx, id);
      await ensureTemplateRoles(trx, id);
      if (created) {
        await trx
          .insertInto('cg.outbox')
          .values({
            tenant_id: id,
            topic: 'tenant.provision',
            payload: JSON.stringify({ tenantId: id }),
            execution_id: randomUUID(),
          })
          .execute();
        await sql`insert into cg.audit_event (tenant_id, actor_kind, action, target_type, target_id, reason)
                  values (${id}::uuid, 'system', 'seed.tenant', 'tenant', ${id}, 'synthetic WESTWIND seed')`.execute(
          trx,
        );
      }
    });
  }

  for (const member of cast) {
    const tenantId = tenantIds[member.tenant];
    if (!tenantId)
      throw new Error(`cast member ${member.email} names unknown tenant ${member.tenant}`);
    await withTenant(db, { tenantId }, async (trx) => {
      const role = await trx
        .selectFrom('cg.role')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('key', '=', member.role)
        .executeTakeFirstOrThrow();
      const { id } = await ensureAccount(trx, tenantId, member, role.id);
      accountIds[member.email] = id;
    });
  }
  return { tenants: tenantIds, accounts: accountIds };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL (cg_worker role) is not set');
    process.exit(2);
  }
  const db = createDb(url, 2);
  const loaded = await loadSeed(db);
  await db.destroy();
  console.log(
    JSON.stringify({
      msg: 'seed loaded',
      tenants: Object.keys(loaded.tenants).length,
      accounts: Object.keys(loaded.accounts).length,
    }),
  );
}
