/**
 * Who at a tenant hears about something: the people whose roles could act on
 * it (role templates granting the action), else the tenant's administrators,
 * else its security contact. Role holders are found by template key, so a
 * county's own copies of a template still count (ADM-04).
 */
import { roleTemplates } from '@cg/authz';
import type { Database } from '@cg/db';
import type { Transaction } from 'kysely';

/** `site.*` covers `site.confirm`; `*` covers everything. */
function covers(grant: string, action: string): boolean {
  if (grant === '*' || grant === action) return true;
  return grant.endsWith('.*') && action.startsWith(grant.slice(0, -1));
}

/** Template keys whose grants cover at least one of the actions. */
export function templatesGranting(actions: readonly string[]): string[] {
  return roleTemplates
    .filter((t) => t.grants.some((g) => actions.some((a) => covers(g.action, a))))
    .map((t) => t.key);
}

export interface Recipients {
  tenantName: string;
  emails: string[];
}

async function emailsByTemplate(
  trx: Transaction<Database>,
  tenantId: string,
  templateKeys: string[],
): Promise<string[]> {
  if (templateKeys.length === 0) return [];
  const rows = await trx
    .selectFrom('cg.account as a')
    .innerJoin('cg.role_assignment as ra', 'ra.account_id', 'a.id')
    .innerJoin('cg.role as r', 'r.id', 'ra.role_id')
    .select('a.email as email')
    .distinct()
    .where('a.tenant_id', '=', tenantId)
    .where('a.status', 'in', ['active', 'invited'])
    .where('ra.status', '=', 'active')
    .where('r.template_key', 'in', templateKeys)
    .execute();
  return rows.map((r) => r.email);
}

/**
 * Role holders for the actions; with `includeAdmins` the administrators are
 * always among them (a partner organization may have nobody else yet).
 */
export async function staffRecipients(
  trx: Transaction<Database>,
  tenantId: string,
  actions: readonly string[],
  opts: { includeAdmins?: boolean } = {},
): Promise<Recipients> {
  const tenant = await trx
    .selectFrom('cg.tenant')
    .select(['name', 'security_contact_email'])
    .where('id', '=', tenantId)
    .executeTakeFirstOrThrow();
  const keys = templatesGranting(actions);
  const emails = new Set(
    await emailsByTemplate(
      trx,
      tenantId,
      opts.includeAdmins ? [...new Set(['tenant_admin', ...keys])] : keys,
    ),
  );
  if (emails.size === 0)
    for (const e of await emailsByTemplate(trx, tenantId, ['tenant_admin'])) emails.add(e);
  if (emails.size === 0 && tenant.security_contact_email) emails.add(tenant.security_contact_email);
  return { tenantName: tenant.name, emails: [...emails] };
}

/** The sign-in emails of the given accounts (owners of a record), active or invited. */
export async function accountEmails(
  trx: Transaction<Database>,
  tenantId: string,
  accountIds: readonly (string | null)[],
): Promise<string[]> {
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];
  const rows = await trx
    .selectFrom('cg.account')
    .select('email')
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', ids)
    .where('status', 'in', ['active', 'invited'])
    .execute();
  return rows.map((r) => r.email);
}
