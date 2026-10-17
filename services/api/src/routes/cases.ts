/**
 * Case management on the shared record (FL-13, FL-03, FL:FR-07, FL:FR-18,
 * FL:FR-27; docs/plans/case-management.md §3.1–3.3, §3.8).
 *
 * - A case is opened on a report by the county's caseworker, or by a partner
 *   organization that holds an active share grant for the report (the
 *   survivor's consent, cut by the worker). The case lives in the county's
 *   tenant; a partner reaches it through its grant the way messages do, and
 *   never reads the county's report itself (SEC-05).
 * - Help received is append-only with source, type and dollar value; an entry
 *   is voided with a reason, never edited or deleted (RULE-10). The
 *   duplication-of-benefits check totals the standing entries by source and
 *   type. Dollar values are the financial data category: a role without it
 *   sees that help was given and never how much (SEC-11, plan §5.1).
 * - The recovery plan lists what is still unmet, who owns it and by when.
 * - Every read is audited with the categories read (SEC-18); closing a case
 *   and voiding an entry are consequential and take a reason (RULE-14).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { FieldDescriptor } from '@cg/authz';
import type { CaseStatus, Database, HelpSourceKind, RecoveryPlanStatus } from '@cg/db';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type CaseRow = Selectable<Database['cg.case']>;
type HelpRow = Selectable<Database['cg.help_received']>;
type PlanRow = Selectable<Database['cg.recovery_plan_item']>;

export const CASE_STATUSES = [
  'open',
  'handed_off',
  'closed',
] as const satisfies readonly CaseStatus[];
export const HELP_SOURCES = [
  'fema_ia',
  'sba_loan',
  'insurance',
  'ngo_grant',
  'ltrg_commitment',
  'goods',
  'services',
  'other',
] as const satisfies readonly HelpSourceKind[];
export const PLAN_STATUSES = [
  'open',
  'in_progress',
  'met',
  'dropped',
] as const satisfies readonly RecoveryPlanStatus[];

/** The parts of a case the policy engine masks by data category (RULE-16, SEC-11). */
const FIELDS: FieldDescriptor[] = [
  { name: 'amount', category: 'financial', classification: 'sensitive' },
  { name: 'description', category: 'free_text', classification: 'sensitive' },
];

const helpOut = z.object({
  id: z.uuid(),
  sourceKind: z.enum(HELP_SOURCES),
  sourceName: z.string(),
  sourceTenantId: z.uuid().nullable(),
  helpType: z.string(),
  description: z.string().nullable(),
  /** Null when there is no dollar value, or when this role may not read financial data. */
  amount: z.number().nullable(),
  givenOn: z.string(),
  recordedBy: z.string().nullable(),
  recordedByTenant: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  voidedAt: z.iso.datetime().nullable(),
  voidedBy: z.string().nullable(),
  voidReason: z.string().nullable(),
});
const planOut = z.object({
  ...stamped,
  needId: z.uuid().nullable(),
  unmet: z.string(),
  ownerTenantId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  ownerLabel: z.string().nullable(),
  dueOn: z.string().nullable(),
  status: z.enum(PLAN_STATUSES),
  referralId: z.uuid().nullable(),
  note: z.string().nullable(),
});
const summaryOut = z.object({
  ...stamped,
  reportId: z.uuid(),
  referenceCode: z.string().nullable(),
  eventId: z.uuid().nullable(),
  eventName: z.string().nullable(),
  status: z.enum(CASE_STATUSES),
  leadTenantId: z.uuid(),
  leadTenantName: z.string().nullable(),
  leadIsYou: z.boolean(),
  openedAt: z.iso.datetime(),
  openedBy: z.string().nullable(),
  handedOffAt: z.iso.datetime().nullable(),
  handedOffToTenantName: z.string().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closedBy: z.string().nullable(),
  closeReason: z.string().nullable(),
  /** Whether this role reads dollar values (the financial category). */
  financialVisible: z.boolean(),
  openPlanItems: z.number().int(),
  helpEntries: z.number().int(),
});
const caseOut = summaryOut.extend({
  helpReceived: z.array(helpOut),
  recoveryPlan: z.array(planOut),
});
type CaseOut = z.infer<typeof caseOut>;

const duplicationOut = z.object({
  caseId: z.uuid(),
  asOf: z.iso.datetime(),
  /** Standing entries only; voided ones are left out of every total. */
  entries: z.number().int(),
  entriesWithoutAmount: z.number().int(),
  total: z.number(),
  bySource: z.array(
    z.object({ sourceKind: z.enum(HELP_SOURCES), entries: z.number().int(), total: z.number() }),
  ),
  byType: z.array(z.object({ helpType: z.string(), entries: z.number().int(), total: z.number() })),
});

const helpIn = z.object({
  sourceKind: z.enum(HELP_SOURCES),
  sourceName: z.string().trim().min(1).max(200),
  sourceTenantId: z.uuid().optional(),
  helpType: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  amount: z.number().min(0).max(999_999_999.99).nullable().optional(),
  givenOn: z.iso.date(),
});
const planIn = z.object({
  needId: z.uuid().optional(),
  unmet: z.string().trim().min(1).max(500),
  ownerTenantId: z.uuid().optional(),
  ownerLabel: z.string().trim().max(120).optional(),
  dueOn: z.iso.date().optional(),
  referralId: z.uuid().optional(),
  note: z.string().trim().max(1000).optional(),
});
const planChangeIn = z.object({
  status: z.enum(PLAN_STATUSES).optional(),
  ownerTenantId: z.uuid().nullable().optional(),
  ownerLabel: z.string().trim().max(120).nullable().optional(),
  dueOn: z.iso.date().nullable().optional(),
  referralId: z.uuid().nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

const num = (v: string | number | null | undefined) =>
  v === null || v === undefined ? null : Number(v);
const day = (v: Date | string | null | undefined) =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : v;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Where a case or a report is reached from: the subject's own county, or a partner's grant. */
interface Where {
  countyId: string;
  viaGrant: boolean;
}

export const caseRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const inCounty = <T>(request: FastifyRequest, countyId: string, fn: (trx: Trx) => Promise<T>) =>
    account(request).tenantId === countyId ? request.tx(fn) : request.txAs(countyId, fn);

  /** The active grants a partner holds for reports (its consented records), by county. */
  async function grantsFor(request: FastifyRequest, reportId?: string) {
    const s = account(request);
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
  async function locateReport(request: FastifyRequest, reportId: string): Promise<Where> {
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
  async function locateCase(
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

  const names = async (trx: Trx, ids: (string | null)[]) => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return new Map<string, string>();
    const rows = await trx
      .selectFrom('cg.account')
      .select(['id', 'display_name'])
      .where('id', 'in', wanted)
      .execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  };
  const tenantNames = async (trx: Trx, ids: (string | null)[]) => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return new Map<string, string>();
    // Tenant names are public (the dictionary); the lookup bypasses no row policy a partner lacks.
    const rows = await sql<{ id: string; name: string }>`
      select id, name from cg.tenant where id = any(${wanted}::uuid[])`.execute(trx);
    return new Map(rows.rows.map((r) => [r.id, r.name]));
  };

  async function summary(
    trx: Trx,
    c: CaseRow,
    me: { accountId: string; tenantId: string },
    financialVisible: boolean,
  ): Promise<z.infer<typeof summaryOut>> {
    const [report, ev, who, orgs, planCount, helpCount] = await Promise.all([
      trx
        .selectFrom('cg.report')
        .select('reference_code')
        .where('id', '=', c.report_id)
        .executeTakeFirst(),
      c.event_id
        ? trx.selectFrom('cg.event').select('name').where('id', '=', c.event_id).executeTakeFirst()
        : Promise.resolve(undefined),
      names(trx, [c.opened_by, c.closed_by]),
      tenantNames(trx, [c.lead_tenant_id, c.handed_off_to_tenant_id]),
      trx
        .selectFrom('cg.recovery_plan_item')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('case_id', '=', c.id)
        .where('status', 'in', ['open', 'in_progress'])
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('cg.help_received')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('case_id', '=', c.id)
        .where('voided_at', 'is', null)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      id: c.id,
      version: c.version,
      createdAt: iso(c.created_at)!,
      updatedAt: iso(c.updated_at)!,
      reportId: c.report_id,
      referenceCode: report?.reference_code ?? null,
      eventId: c.event_id,
      eventName: ev?.name ?? null,
      status: c.status,
      leadTenantId: c.lead_tenant_id,
      leadTenantName: orgs.get(c.lead_tenant_id) ?? null,
      leadIsYou: c.lead_tenant_id === me.tenantId,
      openedAt: iso(c.opened_at)!,
      openedBy: c.opened_by ? (who.get(c.opened_by) ?? null) : null,
      handedOffAt: iso(c.handed_off_at),
      handedOffToTenantName: c.handed_off_to_tenant_id
        ? (orgs.get(c.handed_off_to_tenant_id) ?? null)
        : null,
      closedAt: iso(c.closed_at),
      closedBy: c.closed_by ? (who.get(c.closed_by) ?? null) : null,
      closeReason: c.close_reason,
      financialVisible,
      openPlanItems: Number(planCount.n),
      helpEntries: Number(helpCount.n),
    };
  }

  async function view(
    trx: Trx,
    c: CaseRow,
    me: { accountId: string; tenantId: string },
    visible: string[],
  ): Promise<CaseOut> {
    const financialVisible = visible.includes('amount');
    const textVisible = visible.includes('description');
    const [head, help, plan] = await Promise.all([
      summary(trx, c, me, financialVisible),
      trx
        .selectFrom('cg.help_received')
        .selectAll()
        .where('case_id', '=', c.id)
        .orderBy('given_on', 'desc')
        .orderBy('created_at', 'desc')
        .execute(),
      trx
        .selectFrom('cg.recovery_plan_item')
        .selectAll()
        .where('case_id', '=', c.id)
        .orderBy('status')
        .orderBy('due_on')
        .orderBy('created_at')
        .execute(),
    ]);
    const who = await names(trx, [
      ...help.flatMap((h: HelpRow) => [h.recorded_by, h.voided_by]),
      ...plan.map((p: PlanRow) => p.created_by),
    ]);
    const orgs = await tenantNames(trx, [
      ...help.map((h: HelpRow) => h.recorded_tenant_id),
      ...plan.map((p: PlanRow) => p.owner_tenant_id),
    ]);
    return {
      ...head,
      helpReceived: help.map((h: HelpRow) => ({
        id: h.id,
        sourceKind: h.source_kind,
        sourceName: h.source_name,
        sourceTenantId: h.source_tenant_id,
        helpType: h.help_type,
        description: textVisible ? h.description : null,
        amount: financialVisible ? num(h.amount) : null,
        givenOn: day(h.given_on)!,
        recordedBy: h.recorded_by ? (who.get(h.recorded_by) ?? null) : null,
        recordedByTenant: orgs.get(h.recorded_tenant_id) ?? null,
        recordedAt: iso(h.created_at)!,
        voidedAt: iso(h.voided_at),
        voidedBy: h.voided_by ? (who.get(h.voided_by) ?? null) : null,
        voidReason: h.void_reason,
      })),
      recoveryPlan: plan.map((p: PlanRow) => ({
        id: p.id,
        version: p.version,
        createdAt: iso(p.created_at)!,
        updatedAt: iso(p.updated_at)!,
        needId: p.need_id,
        unmet: p.unmet,
        ownerTenantId: p.owner_tenant_id,
        ownerName: p.owner_tenant_id ? (orgs.get(p.owner_tenant_id) ?? null) : null,
        ownerLabel: p.owner_label,
        dueOn: day(p.due_on),
        status: p.status,
        referralId: p.referral_id,
        note: textVisible ? p.note : null,
      })),
    };
  }

  /** Authorize a read of a case for this subject: the categories it may see, audited (SEC-18). */
  async function readCase(request: FastifyRequest, caseId: string) {
    const s = account(request);
    const { where, row } = await locateCase(request, caseId);
    const decision = await request.authorize(
      'case.read',
      { type: 'case', id: row.id, tenantId: s.tenantId, fields: FIELDS },
      { asNotFound: true },
    );
    return { s, where, row, decision };
  }

  const auditRead = (
    request: FastifyRequest,
    trx: Trx,
    row: CaseRow,
    where: Where,
    read: string[],
    what: string,
  ) =>
    request.audit(trx, {
      action: 'case.read',
      targetType: 'case',
      targetId: row.id,
      targetVersion: row.version,
      changes: {
        fields: [
          { name: 'what', to: what },
          { name: 'categories', to: read.join(',') },
          { name: 'via_grant', to: String(where.viaGrant) },
        ],
      },
    });

  // ---- list ------------------------------------------------------------------------------------

  app.get(
    '/cases',
    {
      schema: {
        tags: ['cases'],
        querystring: listQuery.extend({
          status: z.enum(CASE_STATUSES).optional(),
          eventId: z.uuid().optional(),
          reportId: z.uuid().optional(),
        }),
        response: { 200: z.object({ items: z.array(summaryOut) }) },
      },
    },
    async (request) => {
      const s = account(request);
      const decision = await request.authorize('case.read', {
        type: 'case',
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      const financialVisible = decision.fields.includes('amount');
      const me = { accountId: s.accountId, tenantId: s.tenantId };
      const q = request.query;
      // The county's own cases.
      const own = await request.tx(async (trx) => {
        let qb = trx
          .selectFrom('cg.case')
          .selectAll()
          .orderBy('opened_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.status) qb = qb.where('status', '=', q.status);
        if (q.eventId) qb = qb.where('event_id', '=', q.eventId);
        if (q.reportId) qb = qb.where('report_id', '=', q.reportId);
        const rows = await qb.execute();
        return Promise.all(rows.map((c: CaseRow) => summary(trx, c, me, financialVisible)));
      });
      // Cases on reports shared with this organization (a partner), while consent stands.
      const grants = await grantsFor(request, q.reportId);
      const byCounty = new Map<string, string[]>();
      for (const g of grants) {
        if (g.tenant_id === s.tenantId) continue;
        byCounty.set(g.tenant_id, [...(byCounty.get(g.tenant_id) ?? []), g.report_id!]);
      }
      const shared: z.infer<typeof summaryOut>[] = [];
      for (const [countyId, reportIds] of byCounty) {
        const rows = await request.txAs(countyId, async (trx) => {
          let qb = trx
            .selectFrom('cg.case')
            .selectAll()
            .where('report_id', 'in', reportIds)
            .orderBy('opened_at', 'desc')
            .limit(q.limit);
          if (q.status) qb = qb.where('status', '=', q.status);
          if (q.eventId) qb = qb.where('event_id', '=', q.eventId);
          const found = await qb.execute();
          return Promise.all(found.map((c: CaseRow) => summary(trx, c, me, financialVisible)));
        });
        shared.push(...rows);
      }
      return { items: [...own, ...shared].slice(0, q.limit) };
    },
  );

  // ---- open ------------------------------------------------------------------------------------

  app.post(
    '/cases',
    {
      schema: {
        tags: ['cases'],
        body: z.object({ reportId: z.uuid() }),
        response: { 201: caseOut, 200: caseOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const where = await locateReport(request, request.body.reportId);
      await request.authorize('case.open', { type: 'case', tenantId: s.tenantId });
      const read = await request.authorize('case.read', {
        type: 'case',
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      const me = { accountId: s.accountId, tenantId: s.tenantId };
      const result = await inCounty(request, where.countyId, async (trx) => {
        const report = await trx
          .selectFrom('cg.report')
          .select(['id', 'reporter_party_id', 'event_id', 'withdrawn_at'])
          .where('id', '=', request.body.reportId)
          .executeTakeFirst();
        if (!report || report.withdrawn_at) throw errors.notFound();
        const existing = await trx
          .selectFrom('cg.case')
          .selectAll()
          .where('report_id', '=', report.id)
          .executeTakeFirst();
        if (existing) return { created: false, row: existing };
        const row = await trx
          .insertInto('cg.case')
          .values({
            tenant_id: where.countyId,
            report_id: report.id,
            party_id: report.reporter_party_id,
            event_id: report.event_id,
            status: 'open',
            lead_tenant_id: s.tenantId,
            opened_by: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'case.opened',
          targetType: 'case',
          targetId: row.id,
          targetVersion: row.version,
          changes: {
            fields: [
              { name: 'report_id', to: row.report_id },
              { name: 'lead_tenant_id', to: row.lead_tenant_id },
              { name: 'via_grant', to: String(where.viaGrant) },
            ],
          },
        });
        return { created: true, row };
      });
      const out = await inCounty(request, where.countyId, async (trx) => {
        const v = await view(trx, result.row, me, read.fields);
        await auditRead(request, trx, result.row, where, read.restrictedRead, 'case');
        return v;
      });
      return reply.code(result.created ? 201 : 200).send(out);
    },
  );

  // ---- read ------------------------------------------------------------------------------------

  app.get(
    '/cases/:id',
    { schema: { tags: ['cases'], params: uuidParam, response: { 200: caseOut } } },
    async (request) => {
      const { s, where, row, decision } = await readCase(request, request.params.id);
      return inCounty(request, where.countyId, async (trx) => {
        const v = await view(
          trx,
          row,
          { accountId: s.accountId, tenantId: s.tenantId },
          decision.fields,
        );
        await auditRead(request, trx, row, where, decision.restrictedRead, 'case');
        return v;
      });
    },
  );

  /** FL-13: every dollar by source and type, totalled, before FEMA, SBA or a grant decides. */
  app.get(
    '/cases/:id/duplication',
    { schema: { tags: ['cases'], params: uuidParam, response: { 200: duplicationOut } } },
    async (request) => {
      const { where, row, decision } = await readCase(request, request.params.id);
      // Without the financial category there is no duplication check: the totals are the dollars.
      if (!decision.fields.includes('amount')) throw errors.forbidden();
      return inCounty(request, where.countyId, async (trx) => {
        const rows = await trx
          .selectFrom('cg.help_received')
          .select(['source_kind', 'help_type', 'amount'])
          .where('case_id', '=', row.id)
          .where('voided_at', 'is', null)
          .execute();
        const bySource = new Map<HelpSourceKind, { entries: number; total: number }>();
        const byType = new Map<string, { entries: number; total: number }>();
        let total = 0;
        let withoutAmount = 0;
        for (const r of rows) {
          const amount = num(r.amount);
          if (amount === null) withoutAmount += 1;
          else total += amount;
          const bump = (m: Map<string, { entries: number; total: number }>, k: string) => {
            const cur = m.get(k) ?? { entries: 0, total: 0 };
            m.set(k, { entries: cur.entries + 1, total: cur.total + (amount ?? 0) });
          };
          bump(bySource as Map<string, { entries: number; total: number }>, r.source_kind);
          bump(byType, r.help_type);
        }
        await auditRead(request, trx, row, where, ['financial'], 'duplication');
        return {
          caseId: row.id,
          asOf: new Date().toISOString(),
          entries: rows.length,
          entriesWithoutAmount: withoutAmount,
          total: round2(total),
          bySource: [...bySource]
            .map(([sourceKind, v]) => ({ sourceKind, entries: v.entries, total: round2(v.total) }))
            .sort((a, b) => b.total - a.total || a.sourceKind.localeCompare(b.sourceKind)),
          byType: [...byType]
            .map(([helpType, v]) => ({ helpType, entries: v.entries, total: round2(v.total) }))
            .sort((a, b) => b.total - a.total || a.helpType.localeCompare(b.helpType)),
        };
      });
    },
  );

  // ---- close -----------------------------------------------------------------------------------

  app.post(
    '/cases/:id/close',
    {
      config: { requiresVersion: true },
      schema: { tags: ['cases'], params: uuidParam, response: { 200: caseOut } },
    },
    async (request) => {
      const s = account(request);
      const { where, row } = await locateCase(request, request.params.id);
      await request.authorize('case.close', { type: 'case', id: row.id, tenantId: s.tenantId });
      const read = await request.authorize('case.read', {
        type: 'case',
        id: row.id,
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      const { reason } = request.confirmation();
      const expected = request.expectedVersion();
      if (row.status === 'closed') throw errors.conflict({ status: row.status });
      // Only the lead organization, or the county the case belongs to, closes it.
      if (row.lead_tenant_id !== s.tenantId && where.countyId !== s.tenantId)
        throw errors.forbidden();
      return inCounty(request, where.countyId, async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.case')
            .set({
              status: 'closed',
              closed_at: new Date(),
              closed_by: s.accountId,
              close_reason: reason,
              version: row.version + 1,
              updated_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', row.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          { version: row.version },
        );
        await request.audit(trx, {
          action: 'case.closed',
          targetType: 'case',
          targetId: row.id,
          targetVersion: updated.version,
          reason,
          changes: { fields: [{ name: 'status', from: row.status, to: 'closed' }] },
        });
        return view(trx, updated, { accountId: s.accountId, tenantId: s.tenantId }, read.fields);
      });
    },
  );

  // ---- help received ---------------------------------------------------------------------------

  app.post(
    '/cases/:id/help',
    { schema: { tags: ['cases'], params: uuidParam, body: helpIn, response: { 201: caseOut } } },
    async (request, reply) => {
      const s = account(request);
      const { where, row } = await locateCase(request, request.params.id);
      await request.authorize('help_received.write', {
        type: 'help_received',
        tenantId: s.tenantId,
      });
      const read = await request.authorize('case.read', {
        type: 'case',
        id: row.id,
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      if (row.status === 'closed') throw errors.conflict({ status: row.status });
      const b = request.body;
      const out = await inCounty(request, where.countyId, async (trx) => {
        const entry = await trx
          .insertInto('cg.help_received')
          .values({
            tenant_id: where.countyId,
            case_id: row.id,
            source_kind: b.sourceKind,
            source_name: b.sourceName,
            source_tenant_id: b.sourceTenantId ?? null,
            help_type: b.helpType,
            description: b.description ?? null,
            amount: b.amount ?? null,
            given_on: b.givenOn,
            recorded_tenant_id: s.tenantId,
            recorded_by: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        const touched = assertUpdated(
          await trx
            .updateTable('cg.case')
            .set({ version: row.version + 1, updated_at: new Date(), updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', row.version)
            .returningAll()
            .executeTakeFirst(),
          { version: row.version },
        );
        await request.audit(trx, {
          action: 'help_received.recorded',
          targetType: 'help_received',
          targetId: entry.id,
          targetVersion: entry.version,
          changes: {
            fields: [
              { name: 'case_id', to: row.id },
              { name: 'source_kind', to: b.sourceKind },
              { name: 'help_type', to: b.helpType },
              { name: 'has_amount', to: String(b.amount !== null && b.amount !== undefined) },
            ],
          },
        });
        return view(trx, touched, { accountId: s.accountId, tenantId: s.tenantId }, read.fields);
      });
      return reply.code(201).send(out);
    },
  );

  /** RULE-10: an entry is never edited or deleted; it is voided with a reason and stays visible. */
  app.post(
    '/cases/:id/help/:entryId/void',
    {
      schema: {
        tags: ['cases'],
        params: uuidParam.extend({ entryId: z.uuid() }),
        response: { 200: caseOut },
      },
    },
    async (request) => {
      const s = account(request);
      const { where, row } = await locateCase(request, request.params.id);
      await request.authorize('help_received.void', {
        type: 'help_received',
        id: request.params.entryId,
        tenantId: s.tenantId,
      });
      const read = await request.authorize('case.read', {
        type: 'case',
        id: row.id,
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      const { reason } = request.confirmation();
      return inCounty(request, where.countyId, async (trx) => {
        const entry = await trx
          .selectFrom('cg.help_received')
          .selectAll()
          .where('id', '=', request.params.entryId)
          .where('case_id', '=', row.id)
          .executeTakeFirst();
        if (!entry) throw errors.notFound();
        if (entry.voided_at) throw errors.conflict({ voidedAt: iso(entry.voided_at) });
        // An organization voids its own entries; the county voids any on its case.
        if (entry.recorded_tenant_id !== s.tenantId && where.countyId !== s.tenantId)
          throw errors.forbidden();
        const voided = assertUpdated(
          await trx
            .updateTable('cg.help_received')
            .set({
              voided_at: new Date(),
              voided_by: s.accountId,
              void_reason: reason,
              version: entry.version + 1,
              updated_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', entry.id)
            .where('version', '=', entry.version)
            .returning(['id', 'version'])
            .executeTakeFirst(),
          { version: entry.version },
        );
        const touched = assertUpdated(
          await trx
            .updateTable('cg.case')
            .set({ version: row.version + 1, updated_at: new Date(), updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', row.version)
            .returningAll()
            .executeTakeFirst(),
          { version: row.version },
        );
        await request.audit(trx, {
          action: 'help_received.voided',
          targetType: 'help_received',
          targetId: voided.id,
          targetVersion: voided.version,
          reason,
          changes: { fields: [{ name: 'voided', from: 'false', to: 'true' }] },
        });
        return view(trx, touched, { accountId: s.accountId, tenantId: s.tenantId }, read.fields);
      });
    },
  );

  // ---- recovery plan ---------------------------------------------------------------------------

  app.post(
    '/cases/:id/plan',
    { schema: { tags: ['cases'], params: uuidParam, body: planIn, response: { 201: caseOut } } },
    async (request, reply) => {
      const s = account(request);
      const { where, row } = await locateCase(request, request.params.id);
      await request.authorize('recovery_plan.write', {
        type: 'recovery_plan',
        tenantId: s.tenantId,
      });
      const read = await request.authorize('case.read', {
        type: 'case',
        id: row.id,
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      if (row.status === 'closed') throw errors.conflict({ status: row.status });
      const b = request.body;
      const out = await inCounty(request, where.countyId, async (trx) => {
        const item = await trx
          .insertInto('cg.recovery_plan_item')
          .values({
            tenant_id: where.countyId,
            case_id: row.id,
            need_id: b.needId ?? null,
            unmet: b.unmet,
            owner_tenant_id: b.ownerTenantId ?? null,
            owner_label: b.ownerLabel ?? null,
            due_on: b.dueOn ?? null,
            status: 'open',
            referral_id: b.referralId ?? null,
            note: b.note ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        const touched = assertUpdated(
          await trx
            .updateTable('cg.case')
            .set({ version: row.version + 1, updated_at: new Date(), updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', row.version)
            .returningAll()
            .executeTakeFirst(),
          { version: row.version },
        );
        await request.audit(trx, {
          action: 'recovery_plan.item_added',
          targetType: 'recovery_plan_item',
          targetId: item.id,
          targetVersion: item.version,
          changes: {
            fields: [
              { name: 'case_id', to: row.id },
              { name: 'status', to: 'open' },
            ],
          },
        });
        return view(trx, touched, { accountId: s.accountId, tenantId: s.tenantId }, read.fields);
      });
      return reply.code(201).send(out);
    },
  );

  app.patch(
    '/cases/:id/plan/:itemId',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['cases'],
        params: uuidParam.extend({ itemId: z.uuid() }),
        body: planChangeIn,
        response: { 200: caseOut },
      },
    },
    async (request) => {
      const s = account(request);
      const { where, row } = await locateCase(request, request.params.id);
      await request.authorize('recovery_plan.write', {
        type: 'recovery_plan',
        id: request.params.itemId,
        tenantId: s.tenantId,
      });
      const read = await request.authorize('case.read', {
        type: 'case',
        id: row.id,
        tenantId: s.tenantId,
        fields: FIELDS,
      });
      const expected = request.expectedVersion();
      const b = request.body;
      return inCounty(request, where.countyId, async (trx) => {
        const item = await trx
          .selectFrom('cg.recovery_plan_item')
          .selectAll()
          .where('id', '=', request.params.itemId)
          .where('case_id', '=', row.id)
          .executeTakeFirst();
        if (!item) throw errors.notFound();
        const updated = assertUpdated(
          await trx
            .updateTable('cg.recovery_plan_item')
            .set({
              ...(b.status !== undefined ? { status: b.status } : {}),
              ...(b.ownerTenantId !== undefined ? { owner_tenant_id: b.ownerTenantId } : {}),
              ...(b.ownerLabel !== undefined ? { owner_label: b.ownerLabel } : {}),
              ...(b.dueOn !== undefined ? { due_on: b.dueOn } : {}),
              ...(b.referralId !== undefined ? { referral_id: b.referralId } : {}),
              ...(b.note !== undefined ? { note: b.note } : {}),
              version: item.version + 1,
              updated_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', item.id)
            .where('version', '=', expected)
            .returning(['id', 'version', 'status'])
            .executeTakeFirst(),
          { version: item.version },
        );
        const touched = assertUpdated(
          await trx
            .updateTable('cg.case')
            .set({ version: row.version + 1, updated_at: new Date(), updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', row.version)
            .returningAll()
            .executeTakeFirst(),
          { version: row.version },
        );
        await request.audit(trx, {
          action: 'recovery_plan.item_changed',
          targetType: 'recovery_plan_item',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: {
            fields: [{ name: 'status', from: item.status, to: updated.status }],
          },
        });
        return view(trx, touched, { accountId: s.accountId, tenantId: s.tenantId }, read.fields);
      });
    },
  );
};
