/**
 * The recovery centre queue and warm hand-offs (FL:FR-12; docs/plans/
 * case-management.md §3.5). At a MARC site the door checks a survivor in with
 * the tables to see, in order; each table's queue lists the visits waiting for
 * it; "hand to the next table" moves the visit on with a one-line why, so the
 * survivor does not retell their story. A visit carries only the label given
 * at the door (a first name or the reference code), the arrival time and the
 * tables (plan §5.3): never an address or a dollar. A partner at a table sees
 * the visits that have a stop at its table and its own stops; the county sees
 * the whole floor. Every queue read is audited (SEC-18).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, MarcStopStatus, MarcVisitStatus } from '@cg/db';
import { errors } from '../errors.ts';
import {
  accountNames,
  caseAccount as account,
  countyOf,
  inCounty,
  type Trx,
} from './case-access.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type VisitRow = Selectable<Database['cg.marc_visit']>;
type StopRow = Selectable<Database['cg.marc_stop']>;

const VISIT_STATUSES = [
  'waiting',
  'in_progress',
  'done',
  'left',
] as const satisfies readonly MarcVisitStatus[];
const STOP_STATUSES = [
  'waiting',
  'current',
  'done',
  'skipped',
] as const satisfies readonly MarcStopStatus[];

const stopOut = z.object({
  id: z.uuid(),
  seq: z.number().int(),
  tableTenantId: z.uuid().nullable(),
  tableLabel: z.string(),
  status: z.enum(STOP_STATUSES),
  startedAt: z.iso.datetime().nullable(),
  doneAt: z.iso.datetime().nullable(),
  /** The one-line why from the table that handed the survivor here; your own stops only for a partner. */
  handoffNote: z.string().nullable(),
  handedBy: z.string().nullable(),
  yours: z.boolean(),
});
const visitOut = z.object({
  ...stamped,
  siteId: z.uuid(),
  caseId: z.uuid().nullable(),
  label: z.string(),
  arrivedAt: z.iso.datetime(),
  status: z.enum(VISIT_STATUSES),
  endedAt: z.iso.datetime().nullable(),
  currentTable: z.string().nullable(),
  waitingMinutes: z.number().int(),
  stops: z.array(stopOut),
});
type VisitOut = z.infer<typeof visitOut>;
const siteOut = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  waiting: z.number().int(),
  inProgress: z.number().int(),
});

const checkInIn = z.object({
  caseId: z.uuid().optional(),
  reportId: z.uuid().optional(),
  /** A first name or the reference code; the door never writes more (plan §5.3). */
  label: z.string().trim().min(1).max(80),
  tables: z
    .array(
      z.object({
        tenantId: z.uuid().optional(),
        label: z.string().trim().min(1).max(120),
      }),
    )
    .min(1)
    .max(20),
});
const handoffIn = z.object({
  note: z.string().trim().min(3).max(200),
  /** Hand to a later table than the next one; the ones skipped are marked so. */
  toSeq: z.number().int().min(1).max(20).optional(),
});

export const marcRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  const marcSite = async (trx: Trx, siteId: string) => {
    const site = await trx
      .selectFrom('cg.site')
      .select(['id', 'name', 'status', 'kind'])
      .where('id', '=', siteId)
      .where('kind', '=', 'marc')
      .executeTakeFirst();
    if (!site) throw errors.notFound();
    return site;
  };

  async function render(
    trx: Trx,
    visits: VisitRow[],
    viewer: { tenantId: string; county: boolean },
    now: Date,
  ): Promise<VisitOut[]> {
    if (!visits.length) return [];
    const stops = await trx
      .selectFrom('cg.marc_stop')
      .selectAll()
      .where(
        'visit_id',
        'in',
        visits.map((v) => v.id),
      )
      .orderBy('seq')
      .execute();
    const who = await accountNames(
      trx,
      stops.map((s: StopRow) => s.handed_by),
    );
    return visits.map((v) => {
      const mine = stops.filter((s: StopRow) => s.visit_id === v.id);
      const current = mine.find((s: StopRow) => s.status === 'current');
      return {
        id: v.id,
        version: v.version,
        createdAt: iso(v.created_at)!,
        updatedAt: iso(v.updated_at)!,
        siteId: v.site_id,
        caseId: v.case_id,
        label: v.label,
        arrivedAt: iso(v.arrived_at)!,
        status: v.status,
        endedAt: iso(v.ended_at),
        currentTable: current?.table_label ?? null,
        waitingMinutes: Math.max(
          0,
          Math.round((now.getTime() - new Date(v.arrived_at).getTime()) / 60_000),
        ),
        stops: mine.map((s: StopRow) => {
          const yours = s.table_tenant_id === viewer.tenantId;
          const open = viewer.county || yours;
          return {
            id: s.id,
            seq: s.seq,
            tableTenantId: s.table_tenant_id,
            tableLabel: s.table_label,
            status: s.status,
            startedAt: iso(s.started_at),
            doneAt: iso(s.done_at),
            handoffNote: open ? s.handoff_note : null,
            handedBy: open && s.handed_by ? (who.get(s.handed_by) ?? null) : null,
            yours,
          };
        }),
      };
    });
  }

  const viewerOf = async (request: FastifyRequest) => {
    const s = account(request);
    const countyId = await countyOf(request);
    return { s, countyId, viewer: { tenantId: s.tenantId, county: s.tenantId === countyId } };
  };

  app.get(
    '/marc/sites',
    { schema: { tags: ['marc'], response: { 200: z.array(siteOut) } } },
    async (request) => {
      const { s, countyId } = await viewerOf(request);
      await request.authorize('marc.queue', { type: 'marc_visit', tenantId: s.tenantId });
      return inCounty(request, countyId, async (trx) => {
        const sites = await trx
          .selectFrom('cg.site')
          .select(['id', 'name', 'status'])
          .where('kind', '=', 'marc')
          .where('status', '<>', 'closed')
          .orderBy('name')
          .execute();
        const counts = sites.length
          ? await trx
              .selectFrom('cg.marc_visit')
              .select(['site_id', 'status', ({ fn }) => fn.countAll<string>().as('n')])
              .where(
                'site_id',
                'in',
                sites.map((x) => x.id),
              )
              .where('status', 'in', ['waiting', 'in_progress'])
              .groupBy(['site_id', 'status'])
              .execute()
          : [];
        const n = (siteId: string, status: string) =>
          Number(counts.find((c) => c.site_id === siteId && c.status === status)?.n ?? 0);
        return sites.map((x) => ({
          id: x.id,
          name: x.name,
          status: x.status,
          waiting: n(x.id, 'waiting'),
          inProgress: n(x.id, 'in_progress'),
        }));
      });
    },
  );

  app.post(
    '/marc/sites/:id/visits',
    {
      schema: {
        tags: ['marc'],
        params: uuidParam,
        body: checkInIn,
        response: { 201: visitOut },
      },
    },
    async (request, reply) => {
      const { s, countyId, viewer } = await viewerOf(request);
      await request.authorize('marc.check_in', { type: 'marc_visit', tenantId: s.tenantId });
      const b = request.body;
      const out = await inCounty(request, countyId, async (trx) => {
        const site = await marcSite(trx, request.params.id);
        if (site.status === 'closed') throw errors.conflict({ status: site.status });
        let caseId = b.caseId ?? null;
        let reportId = b.reportId ?? null;
        if (caseId) {
          const c = await trx
            .selectFrom('cg.case')
            .select(['id', 'report_id'])
            .where('id', '=', caseId)
            .executeTakeFirst();
          if (!c) throw errors.validation([{ name: 'caseId', message: 'unknown case' }]);
          reportId = c.report_id;
        } else if (reportId) {
          const c = await trx
            .selectFrom('cg.case')
            .select('id')
            .where('report_id', '=', reportId)
            .executeTakeFirst();
          caseId = c?.id ?? null;
        }
        const now = new Date();
        const visit = await trx
          .insertInto('cg.marc_visit')
          .values({
            tenant_id: countyId,
            site_id: site.id,
            case_id: caseId,
            report_id: reportId,
            label: b.label,
            arrived_at: now,
            status: 'in_progress',
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.marc_stop')
          .values(
            b.tables.map((t, i) => ({
              tenant_id: countyId,
              visit_id: visit.id,
              seq: i + 1,
              table_tenant_id: t.tenantId ?? null,
              table_label: t.label,
              status: i === 0 ? ('current' as const) : ('waiting' as const),
              started_at: i === 0 ? now : null,
              created_by: s.accountId,
              updated_by: s.accountId,
            })),
          )
          .execute();
        await request.audit(trx, {
          action: 'marc.checked_in',
          targetType: 'marc_visit',
          targetId: visit.id,
          targetVersion: visit.version,
          changes: {
            fields: [
              { name: 'site_id', to: site.id },
              { name: 'tables', to: String(b.tables.length) },
              { name: 'case_id', to: caseId ?? '' },
            ],
          },
        });
        return (await render(trx, [visit], viewer, now))[0]!;
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/marc/sites/:id/queue',
    {
      schema: {
        tags: ['marc'],
        params: uuidParam,
        querystring: listQuery.extend({
          /** The table's organization, or its label as given at the door. */
          table: z.string().trim().max(120).optional(),
          includeEnded: z.coerce.boolean().default(false),
        }),
        response: { 200: z.object({ items: z.array(visitOut) }) },
      },
    },
    async (request) => {
      const { s, countyId, viewer } = await viewerOf(request);
      await request.authorize('marc.queue', { type: 'marc_visit', tenantId: s.tenantId });
      const q = request.query;
      return inCounty(request, countyId, async (trx) => {
        const site = await marcSite(trx, request.params.id);
        let qb = trx
          .selectFrom('cg.marc_visit')
          .selectAll()
          .where('site_id', '=', site.id)
          .orderBy('arrived_at')
          .limit(q.limit)
          .offset(q.offset);
        if (!q.includeEnded) qb = qb.where('status', 'in', ['waiting', 'in_progress']);
        // A partner sees only visits with a stop at its table; the county may ask for one table.
        const table = viewer.county ? q.table : viewer.tenantId;
        if (table)
          qb = qb.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('cg.marc_stop')
                .select('id')
                .whereRef('cg.marc_stop.visit_id', '=', 'cg.marc_visit.id')
                .where((eb) =>
                  eb.or([
                    eb('cg.marc_stop.table_tenant_id', '=', table),
                    eb('cg.marc_stop.table_label', '=', table),
                  ]),
                ),
            ),
          );
        const visits = await qb.execute();
        const items = await render(trx, visits, viewer, new Date());
        await request.audit(trx, {
          action: 'marc.queue_read',
          targetType: 'site',
          targetId: site.id,
          changes: {
            fields: [
              { name: 'visits', to: String(items.length) },
              { name: 'table', to: table ?? 'all' },
            ],
          },
        });
        return { items };
      });
    },
  );

  /** The warm hand-off: this table is done; the next one is told why the survivor is coming. */
  app.post(
    '/marc/visits/:id/handoff',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['marc'],
        params: uuidParam,
        body: handoffIn,
        response: { 200: visitOut },
      },
    },
    async (request) => {
      const { s, countyId, viewer } = await viewerOf(request);
      await request.authorize('marc.queue', {
        type: 'marc_visit',
        id: request.params.id,
        tenantId: s.tenantId,
      });
      const expected = request.expectedVersion();
      return inCounty(request, countyId, async (trx) => {
        const visit = await trx
          .selectFrom('cg.marc_visit')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!visit) throw errors.notFound();
        if (visit.status !== 'in_progress' && visit.status !== 'waiting')
          throw errors.conflict({ status: visit.status });
        const stops = await trx
          .selectFrom('cg.marc_stop')
          .selectAll()
          .where('visit_id', '=', visit.id)
          .orderBy('seq')
          .execute();
        const current = stops.find((x: StopRow) => x.status === 'current');
        // The current table hands off; so does the county's floor staff.
        if (!viewer.county && current && current.table_tenant_id !== s.tenantId)
          throw errors.forbidden();
        if (!viewer.county && !current) throw errors.forbidden();
        const now = new Date();
        const nextSeq =
          request.body.toSeq ??
          stops.find((x: StopRow) => x.status === 'waiting' && x.seq > (current?.seq ?? 0))?.seq ??
          null;
        const next = nextSeq === null ? undefined : stops.find((x: StopRow) => x.seq === nextSeq);
        if (
          nextSeq !== null &&
          (!next || next.status !== 'waiting' || next.seq <= (current?.seq ?? 0))
        )
          throw errors.validation([{ name: 'toSeq', message: 'not a table still to see' }]);
        if (current)
          await trx
            .updateTable('cg.marc_stop')
            .set({ status: 'done', done_at: now, updated_at: now, updated_by: s.accountId })
            .where('id', '=', current.id)
            .execute();
        if (next) {
          // Tables passed over on the way are marked skipped, never silently lost.
          await trx
            .updateTable('cg.marc_stop')
            .set({ status: 'skipped', updated_at: now, updated_by: s.accountId })
            .where('visit_id', '=', visit.id)
            .where('status', '=', 'waiting')
            .where('seq', '<', next.seq)
            .execute();
          await trx
            .updateTable('cg.marc_stop')
            .set({
              status: 'current',
              started_at: now,
              handoff_note: request.body.note,
              handed_by: s.accountId,
              updated_at: now,
              updated_by: s.accountId,
            })
            .where('id', '=', next.id)
            .execute();
        }
        const updated = await trx
          .updateTable('cg.marc_visit')
          .set({
            status: next ? 'in_progress' : 'done',
            ended_at: next ? null : now,
            version: visit.version + 1,
            updated_at: now,
            updated_by: s.accountId,
          })
          .where('id', '=', visit.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw errors.conflict({ version: visit.version });
        await request.audit(trx, {
          action: 'marc.handoff',
          targetType: 'marc_visit',
          targetId: visit.id,
          targetVersion: updated.version,
          changes: {
            fields: [
              { name: 'from', to: current?.table_label ?? 'door' },
              { name: 'to', to: next?.table_label ?? 'done' },
            ],
          },
        });
        return (await render(trx, [updated], viewer, now))[0]!;
      });
    },
  );

  /** The survivor left before the tables were done. */
  app.post(
    '/marc/visits/:id/leave',
    {
      config: { requiresVersion: true },
      schema: { tags: ['marc'], params: uuidParam, response: { 200: visitOut } },
    },
    async (request) => {
      const { s, countyId, viewer } = await viewerOf(request);
      await request.authorize('marc.check_in', {
        type: 'marc_visit',
        id: request.params.id,
        tenantId: s.tenantId,
      });
      const expected = request.expectedVersion();
      return inCounty(request, countyId, async (trx) => {
        const visit = await trx
          .selectFrom('cg.marc_visit')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!visit) throw errors.notFound();
        if (visit.status === 'done' || visit.status === 'left')
          throw errors.conflict({ status: visit.status });
        const now = new Date();
        await trx
          .updateTable('cg.marc_stop')
          .set({ status: 'skipped', updated_at: now, updated_by: s.accountId })
          .where('visit_id', '=', visit.id)
          .where('status', 'in', ['waiting', 'current'])
          .execute();
        const updated = await trx
          .updateTable('cg.marc_visit')
          .set({
            status: 'left',
            ended_at: now,
            version: visit.version + 1,
            updated_at: now,
            updated_by: s.accountId,
          })
          .where('id', '=', visit.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw errors.conflict({ version: visit.version });
        await request.audit(trx, {
          action: 'marc.left',
          targetType: 'marc_visit',
          targetId: visit.id,
          targetVersion: updated.version,
          changes: { fields: [{ name: 'status', from: visit.status, to: 'left' }] },
        });
        return (await render(trx, [updated], viewer, now))[0]!;
      });
    },
  );
};
