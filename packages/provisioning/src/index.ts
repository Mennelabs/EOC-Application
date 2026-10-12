/**
 * What every new tenant gets (ADM-01, ADM-04, SEC-13), shared by the worker's
 * tenant.provision job and the synthetic seed loader. Idempotent: safe to
 * run again on a tenant that already has some of it.
 */
import { sql, type Transaction } from 'kysely';
import { roleTemplates } from '@cg/authz';
import type { Database } from '@cg/db';

/** One role per shipped template, version 1 current. Returns role ids by template key. */
export async function ensureTemplateRoles(
  trx: Transaction<Database>,
  tenantId: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const t of roleTemplates) {
    const existing = await trx
      .selectFrom('cg.role')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', t.key)
      .executeTakeFirst();
    if (existing) {
      ids.set(t.key, existing.id);
      continue;
    }
    const role = await trx
      .insertInto('cg.role')
      .values({
        tenant_id: tenantId,
        key: t.key,
        name: t.name,
        description: t.description,
        template_key: t.key,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cg.role_version')
      .values({
        tenant_id: tenantId,
        role_id: role.id,
        version: 1,
        grants: JSON.stringify(t.grants),
        change_reason: 'shipped template',
      })
      .execute();
    ids.set(t.key, role.id);
  }
  return ids;
}

/** SEC-13 defaults (7 years with the named exceptions); no-op if already present. */
export async function ensureRetentionDefaults(
  trx: Transaction<Database>,
  tenantId: string,
): Promise<void> {
  await sql`select cg.seed_retention_defaults(${tenantId}::uuid, null)`.execute(trx);
}

/**
 * Every tenant starts with the shipped question graph as published version 1
 * (INT-01, CON-02). A county edits it as configuration from then on.
 */
export async function ensureIntakeGraph(
  trx: Transaction<Database>,
  tenantId: string,
  graph: { key: string; version: number; hazards: readonly string[]; languages: readonly string[] },
): Promise<boolean> {
  const existing = await trx
    .selectFrom('cg.intake_graph')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', graph.key)
    .executeTakeFirst();
  if (existing) return false;
  await trx
    .insertInto('cg.intake_graph')
    .values({
      tenant_id: tenantId,
      key: graph.key,
      graph_version: graph.version,
      status: 'published',
      graph: JSON.stringify(graph),
      hazards: [...graph.hazards],
      languages: [...graph.languages],
      change_reason: 'shipped default graph',
      published_at: new Date(),
    })
    .execute();
  return true;
}
