/**
 * Reaching a case from the county or from a partner (FL-03, SEC-05; plan
 * §3.8). A case lives in the county's tenant. The county's staff read it under
 * their own tenant; a partner organization reaches it through an active share
 * grant for the case's report (the survivor's consent as the worker cut it),
 * in the county's transaction, and never reads the county's report itself.
 * Shared by the case, appointment and recovery-centre routes.
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { FieldDescriptor } from '@cg/authz';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';

export type Trx = Transaction<Database>;
export type CaseRow = Selectable<Database['cg.case']>;

/** Where a case or a report is reached from: the subject's own county, or a partner's grant. */
export interface Where {
  countyId: string;
  viaGrant: boolean;
}

/** The parts of a case the policy engine masks by data category (RULE-16, SEC-11). */
export const CASE_FIELDS: FieldDescriptor[] = [
  { name: 'amount', category: 'financial', classification: 'sensitive' },
  { name: 'description', category: 'free_text', classification: 'sensitive' },
];

export const caseAccount = (request: FastifyRequest) => {
  const s = request.subject;
  if (s.kind !== 'account') throw errors.unauthorized();
  return s;
};

export const inCounty = <T>(
  request: FastifyRequest,
  countyId: string,
  fn: (trx: Trx) => Promise<T>,
) => (caseAccount(request).tenantId === countyId ? request.tx(fn) : request.txAs(countyId, fn));

/** The active grants a partner holds for reports (its consented records), by county. */
export async function grantsFor(request: FastifyRequest, reportId?: string) {
  const s = caseAccount(request);
  return request.tx((trx) => {
    let q = trx
      .selectFrom('cg.share_grant')
      .select(['tenant_id', 'report_id', 'id'])
      .where('to_tenant_id', '=', s.tenantId)
      .where('revoked_at', 'is', null)
      .where('report_id', 'is not', null);
    if (reportId) q = q.where('report_id', '=', reportId);
    return q.execute();
  });
}

/** A report's county: own report, or a report shared with this organization while consent stands. */
export async function locateReport(request: FastifyRequest, reportId: string): Promise<Where> {
  const own = await request.tx((trx) =>
    trx
      .selectFrom('cg.report')
      .select(['id', 'tenant_id'])
      .where('id', '=', reportId)
      .executeTakeFirst(),
  );
  if (own) return { countyId: own.tenant_id, viaGrant: false };
  const [grant] = await grantsFor(request, reportId);
  if (!grant) throw errors.notFound(); // never says whether the report exists (SEC-05)
  return { countyId: grant.tenant_id, viaGrant: true };
}

/** A case: in the subject's own tenant, or in a county whose grant for the case's report it holds. */
export async function locateCase(
  request: FastifyRequest,
  caseId: string,
): Promise<{ where: Where; row: CaseRow }> {
  const own = await request.tx((trx) =>
    trx.selectFrom('cg.case').selectAll().where('id', '=', caseId).executeTakeFirst(),
  );
  if (own) return { where: { countyId: own.tenant_id, viaGrant: false }, row: own };
  const grants = await grantsFor(request);
  const reportIds = new Set(grants.map((g) => g.report_id));
  for (const countyId of new Set(grants.map((g) => g.tenant_id))) {
    const row = await request.txAs(countyId, (trx) =>
      trx.selectFrom('cg.case').selectAll().where('id', '=', caseId).executeTakeFirst(),
    );
    if (row && reportIds.has(row.report_id)) return { where: { countyId, viaGrant: true }, row };
  }
  throw errors.notFound();
}

/**
 * The county a partner organization works under: its own tenant when it is a county, else the
 * nearest county above it. A recovery centre's queues belong to that county (FL:FR-12).
 */
export async function countyOf(request: FastifyRequest): Promise<string> {
  const s = caseAccount(request);
  if (s.tenantKind === 'county') return s.tenantId;
  const row = await request.tx(async (trx) => {
    const r = await sql<{ id: string }>`
      select p.id from cg.tenant t
      join cg.tenant p on p.path @> t.path and p.kind = 'county'
      where t.id = ${s.tenantId}::uuid
      order by nlevel(p.path) desc limit 1`.execute(trx);
    return r.rows[0];
  });
  if (!row) throw errors.notFound();
  return row.id;
}

/** Account display names by id, for who did what. */
export async function accountNames(trx: Trx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await trx
    .selectFrom('cg.account')
    .select(['id', 'display_name'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

/** Tenant names by id. Tenant names are public (the dictionary); no row policy a partner lacks. */
export async function tenantNames(trx: Trx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await sql<{ id: string; name: string }>`
    select id, name from cg.tenant where id = any(${wanted}::uuid[])`.execute(trx);
  return new Map(rows.rows.map((r) => [r.id, r.name]));
}
