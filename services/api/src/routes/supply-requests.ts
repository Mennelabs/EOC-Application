/**
 * Requests for supplies from a site (FL:FR-21, FL:FR-22):
 * - a distribution point or shelter asks the warehouse for items, line by
 *   line; a request made by hand is sent at once;
 * - when an item reaches its reorder point the site's draft gains a line,
 *   created if there is none, with a suggested quantity: a day's use at the
 *   last 24 hours' rate, plus enough to get back to the reorder point. A
 *   draft is never sent on its own; a person checks the lines and sends it;
 * - the warehouse marks a sent request filled, optionally naming the
 *   delivery mission that carried it; a draft or sent request can be
 *   canceled. Every step is audited and versioned.
 * Items already on a sent request that is not yet filled are not drafted
 * again, so one shortage is asked for once.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, SupplyRequestLine } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type Row = Selectable<Database['cg.supply_request']>;

const statuses = ['draft', 'sent', 'filled', 'canceled'] as const;

const lineOut = z.object({
  stockItemId: z.uuid(),
  name: z.string(),
  unit: z.string(),
  quantity: z.number(),
  suggested: z.number().nullable(),
});
const requestOut = z.object({
  ...stamped,
  siteId: z.uuid(),
  siteName: z.string().nullable(),
  status: z.enum(statuses),
  draftedAutomatically: z.boolean(),
  lines: z.array(lineOut),
  note: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  filledAt: z.iso.datetime().nullable(),
  missionId: z.uuid().nullable(),
  canceledAt: z.iso.datetime().nullable(),
});
type RequestOut = z.infer<typeof requestOut>;

const lineIn = z.object({
  stockItemId: z.uuid(),
  quantity: z.number().min(0).max(1_000_000),
});

function toOut(r: Row, siteName: string | null): RequestOut {
  return {
    id: r.id,
    version: r.version,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    siteId: r.site_id,
    siteName,
    status: r.status,
    draftedAutomatically: r.drafted_automatically,
    lines: (r.lines ?? []).map((l) => ({
      stockItemId: l.stockItemId,
      name: l.name,
      unit: l.unit,
      quantity: Number(l.quantity),
      suggested: l.suggested === undefined ? null : Number(l.suggested),
    })),
    note: r.note,
    sentAt: iso(r.sent_at),
    filledAt: iso(r.filled_at),
    missionId: r.mission_id,
    canceledAt: iso(r.canceled_at),
  };
}

/**
 * FL:FR-22: an item at a site reached its reorder point. Adds a line to the
 * site's draft (creating it), unless a draft or an unfilled sent request
 * already asks for the item. Returns the draft's id when a line was added.
 */
export async function draftResupply(
  trx: Trx,
  input: {
    tenantId: string;
    accountId: string;
    item: { id: string; site_id: string; name: string; unit: string; reorder_at: unknown };
    quantity: number;
  },
): Promise<string | null> {
  const { item } = input;
  const open = await trx
    .selectFrom('cg.supply_request')
    .select(['id', 'status', 'lines', 'version'])
    .where('site_id', '=', item.site_id)
    .where('status', 'in', ['draft', 'sent'])
    .execute();
  if (open.some((r) => (r.lines ?? []).some((l) => l.stockItemId === item.id))) return null;
  const used = await trx
    .selectFrom('cg.stock_movement')
    .select(sql<string>`coalesce(sum(quantity), 0)`.as('n'))
    .where('stock_item_id', '=', item.id)
    .where('kind', 'in', ['issued', 'transferred'])
    .where('occurred_at', '>', sql<Date>`now() - interval '24 hours'`)
    .executeTakeFirstOrThrow();
  const reorderAt = Number(item.reorder_at ?? 0);
  const suggested = Math.max(1, Math.ceil(Number(used.n) + reorderAt - input.quantity));
  const line: SupplyRequestLine = {
    stockItemId: item.id,
    name: item.name,
    unit: item.unit,
    quantity: suggested,
    suggested,
  };
  const draft = open.find((r) => r.status === 'draft');
  if (draft) {
    await trx
      .updateTable('cg.supply_request')
      .set({ lines: JSON.stringify([...(draft.lines ?? []), line]), updated_by: input.accountId })
      .where('id', '=', draft.id)
      .execute();
    return draft.id;
  }
  const created = await trx
    .insertInto('cg.supply_request')
    .values({
      tenant_id: input.tenantId,
      site_id: item.site_id,
      drafted_automatically: true,
      lines: JSON.stringify([line]),
      created_by: input.accountId,
      updated_by: input.accountId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return created.id;
}

export const supplyRequestRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const query = (trx: Trx) =>
    trx
      .selectFrom('cg.supply_request as r')
      .leftJoin('cg.site as s', 's.id', 'r.site_id')
      .selectAll('r')
      .select('s.name as site_name');

  /** The site's items for the lines asked for; every line must be one of them. */
  async function linesFor(
    trx: Trx,
    siteId: string,
    lines: z.infer<typeof lineIn>[],
    keep: SupplyRequestLine[] = [],
  ): Promise<SupplyRequestLine[]> {
    const wanted = lines.filter((l) => l.quantity > 0);
    if (wanted.length === 0)
      throw errors.validation([{ name: 'lines', message: 'ask for at least one item' }]);
    const items = await trx
      .selectFrom('cg.stock_item')
      .select(['id', 'name', 'unit'])
      .where('site_id', '=', siteId)
      .where(
        'id',
        'in',
        wanted.map((l) => l.stockItemId),
      )
      .execute();
    return wanted.map((l, i) => {
      const it = items.find((x) => x.id === l.stockItemId);
      if (!it)
        throw errors.validation([
          { name: `lines.${i}.stockItemId`, message: 'not an item at this site' },
        ]);
      const before = keep.find((k) => k.stockItemId === l.stockItemId);
      return {
        stockItemId: it.id,
        name: it.name,
        unit: it.unit,
        quantity: l.quantity,
        ...(before?.suggested !== undefined ? { suggested: before.suggested } : {}),
      };
    });
  }

  app.get(
    '/supply-requests',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          siteId: z.uuid().optional(),
          status: z.enum(statuses).optional(),
          /** Draft and sent: what still needs someone. */
          open: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(requestOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('stock.read', { type: 'stock_item', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = query(trx).orderBy('r.updated_at', 'desc').limit(q.limit).offset(q.offset);
        if (q.siteId) x = x.where('r.site_id', '=', q.siteId);
        if (q.status) x = x.where('r.status', '=', q.status);
        if (q.open) x = x.where('r.status', 'in', ['draft', 'sent']);
        return x.execute();
      });
      return rows.map((r) => toOut(r, r.site_name));
    },
  );

  // FL:FR-21: a site asks the warehouse by hand; sent at once.
  app.post(
    '/supply-requests',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          clientUuid: z.uuid(),
          siteId: z.uuid(),
          lines: z.array(lineIn).min(1).max(100),
          note: z.string().max(500).optional(),
        }),
        response: { 200: requestOut, 201: requestOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('stock.write', { type: 'stock_item', tenantId: s.tenantId });
      const b = request.body;
      const { row, created } = await request.tx(async (trx) => {
        const seen = await query(trx).where('r.client_uuid', '=', b.clientUuid).executeTakeFirst();
        if (seen) return { row: seen, created: false };
        const site = await trx
          .selectFrom('cg.site')
          .select('id')
          .where('id', '=', b.siteId)
          .executeTakeFirst();
        if (!site) throw errors.validation([{ name: 'siteId', message: 'unknown site' }]);
        const lines = await linesFor(trx, b.siteId, b.lines);
        const now = new Date();
        const inserted = await trx
          .insertInto('cg.supply_request')
          .values({
            tenant_id: s.tenantId,
            site_id: b.siteId,
            client_uuid: b.clientUuid,
            status: 'sent',
            lines: JSON.stringify(lines),
            note: b.note ?? null,
            sent_at: now,
            sent_by: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'stock.write',
          targetType: 'supply_request',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'status', to: 'sent' },
              { name: 'lines', to: lines.length },
            ],
          },
        });
        return {
          row: await query(trx).where('r.id', '=', inserted.id).executeTakeFirstOrThrow(),
          created: true,
        };
      });
      return reply.code(created ? 201 : 200).send(toOut(row, row.site_name));
    },
  );

  /** A versioned step on one request: loads it, checks the state, updates, audits. */
  async function step(
    request: FastifyRequest<{ Params: { id: string } }>,
    from: (typeof statuses)[number][],
    apply: (r: Row, trx: Trx, accountId: string) => Promise<Record<string, unknown>>,
    to: (typeof statuses)[number],
  ): Promise<RequestOut> {
    const s = account(request);
    await request.authorize('stock.write', { type: 'stock_item', tenantId: s.tenantId });
    const expected = request.expectedVersion();
    const row = await request.tx(async (trx) => {
      const current = await query(trx).where('r.id', '=', request.params.id).executeTakeFirst();
      if (!current) throw errors.notFound();
      if (!from.includes(current.status))
        throw new ApiError(
          409,
          'wrong_state',
          `This request is ${current.status}; it cannot be ${to} from there.`,
          { details: { current: toOut(current, current.site_name) } },
        );
      const set = await apply(current, trx, s.accountId);
      const updated = assertUpdated(
        await trx
          .updateTable('cg.supply_request')
          .set({ ...set, status: to, updated_by: s.accountId })
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst(),
        toOut(current, current.site_name),
      );
      await request.audit(trx, {
        action: 'stock.write',
        targetType: 'supply_request',
        targetId: updated.id,
        targetVersion: updated.version,
        changes: { fields: [{ name: 'status', from: current.status, to }] },
      });
      return { ...updated, site_name: current.site_name };
    });
    return toOut(row, row.site_name);
  }

  // FL:FR-22: a person checks the draft's lines, changes any quantity, and sends it.
  app.post(
    '/supply-requests/:id/send',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({
          lines: z.array(lineIn).max(100).optional(),
          note: z.string().max(500).optional(),
        }),
        response: { 200: requestOut },
      },
    },
    (request) =>
      step(
        request,
        ['draft'],
        async (r, trx, accountId) => {
          const lines = request.body.lines
            ? await linesFor(trx, r.site_id, request.body.lines, r.lines ?? [])
            : (r.lines ?? []).filter((l) => Number(l.quantity) > 0);
          if (lines.length === 0)
            throw errors.validation([{ name: 'lines', message: 'ask for at least one item' }]);
          return {
            lines: JSON.stringify(lines),
            ...(request.body.note !== undefined ? { note: request.body.note } : {}),
            sent_at: new Date(),
            sent_by: accountId,
          };
        },
        'sent',
      ),
  );

  // FL:FR-21: the warehouse filled it, by a delivery mission when there was one.
  app.post(
    '/supply-requests/:id/fill',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({ missionId: z.uuid().optional() }),
        response: { 200: requestOut },
      },
    },
    (request) =>
      step(
        request,
        ['sent'],
        async (_r, trx, accountId) => {
          if (request.body.missionId) {
            const m = await trx
              .selectFrom('cg.mission')
              .select('id')
              .where('id', '=', request.body.missionId)
              .executeTakeFirst();
            if (!m) throw errors.validation([{ name: 'missionId', message: 'unknown mission' }]);
          }
          return {
            filled_at: new Date(),
            filled_by: accountId,
            mission_id: request.body.missionId ?? null,
          };
        },
        'filled',
      ),
  );

  app.post(
    '/supply-requests/:id/cancel',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({}).optional(),
        response: { 200: requestOut },
      },
    },
    (request) =>
      step(
        request,
        ['draft', 'sent'],
        async (_r, _trx, accountId) => ({ canceled_at: new Date(), canceled_by: accountId }),
        'canceled',
      ),
  );
};
