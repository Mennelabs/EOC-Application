/**
 * Resource requests to the state (CON-13; the ICS 213 RR blocks; layer-8 plan §3).
 *
 * - A section drafts a request for an event: each line a quantity, kind, type
 *   and description; the delivery or reporting location; who asks and in which
 *   position; priority; substitutes and suggested sources; notes. A site's
 *   supply request (FL:FR-21) can be raised to one, keeping the link.
 * - Submit, approve, place and cancel each take a reason (RULE-14). A second
 *   person approves as section chief: never the one who submitted it (ADM-05
 *   G4, refused by the engine and by the table). Logistics places it with the
 *   state, recording the state's tracking number, or locally.
 * - Finance's reply and the cost stay on the request. When the county sets
 *   `resource_requests.finance_threshold`, a request at or above it is not
 *   placed until finance has replied (plan §13 question 5; off by default).
 * - Every step is a row in cg.resource_request_step and an audit entry; the
 *   request is versioned (FR-00.*). Lines hold counts and descriptions of
 *   things, never a resident (plan §12).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, ResourceRequestStatus, ResourceRequestStep } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { configValue } from '../public/submit.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type Row = Selectable<Database['cg.resource_request']>;
type LineRow = Selectable<Database['cg.resource_request_line']>;
type StepRow = Selectable<Database['cg.resource_request_step']>;

export const STATUSES = [
  'draft',
  'submitted',
  'approved',
  'placed',
  'en_route',
  'received',
  'cancelled',
] as const;
const PRIORITIES = ['urgent', 'high', 'low'] as const;
/** The county's setting: a cost at or above which finance replies before the order is placed. */
export const FINANCE_THRESHOLD_KEY = 'resource_requests.finance_threshold';

const lineIn = z.object({
  quantity: z.number().positive().max(1_000_000),
  unit: z.string().trim().max(40).optional(),
  kind: z.string().trim().min(1).max(120),
  type: z.string().trim().max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  eta: z.iso.datetime().optional(),
  cost: z.number().min(0).max(1_000_000_000).optional(),
});
const lineOut = z.object({
  lineNo: z.number().int(),
  quantity: z.number(),
  unit: z.string().nullable(),
  kind: z.string(),
  type: z.string().nullable(),
  description: z.string().nullable(),
  eta: z.iso.datetime().nullable(),
  cost: z.number().nullable(),
});
const stepOut = z.object({
  step: z.string(),
  fromStatus: z.string().nullable(),
  toStatus: z.string().nullable(),
  reason: z.string().nullable(),
  stateTrackingNumber: z.string().nullable(),
  occurredAt: z.iso.datetime(),
  actorKind: z.string(),
  actorName: z.string().nullable(),
});
const requestOut = z.object({
  ...stamped,
  eventId: z.uuid(),
  eventName: z.string().nullable(),
  requestNumber: z.string(),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  supplyRequestId: z.uuid().nullable(),
  deliveryLocation: z.string().nullable(),
  requestedByName: z.string(),
  requestedByPosition: z.string().nullable(),
  substitutes: z.string().nullable(),
  suggestedSources: z.string().nullable(),
  notes: z.string().nullable(),
  costEstimate: z.number().nullable(),
  financeReply: z.string().nullable(),
  financeRepliedAt: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  submittedBy: z.string().nullable(),
  submittedByYou: z.boolean(),
  approvedAt: z.iso.datetime().nullable(),
  approvedBy: z.string().nullable(),
  placedAt: z.iso.datetime().nullable(),
  placedWith: z.enum(['state', 'local']).nullable(),
  stateTrackingNumber: z.string().nullable(),
  supplier: z.string().nullable(),
  logisticsOrderNumber: z.string().nullable(),
  eta: z.iso.datetime().nullable(),
  arrivedAt: z.iso.datetime().nullable(),
  receivedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  financeReplyNeeded: z.boolean(),
  lines: z.array(lineOut),
  steps: z.array(stepOut),
});
type RequestOut = z.infer<typeof requestOut>;

const headerIn = z.object({
  priority: z.enum(PRIORITIES).optional(),
  deliveryLocation: z.string().trim().max(500).optional(),
  requestedByPosition: z.string().trim().max(120).optional(),
  substitutes: z.string().trim().max(2000).optional(),
  suggestedSources: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(4000).optional(),
  costEstimate: z.number().min(0).max(1_000_000_000).nullable().optional(),
});
const draftIn = headerIn.extend({
  eventId: z.uuid(),
  /** FL:FR-21: raise a site's supply request; its lines are copied. */
  supplyRequestId: z.uuid().optional(),
  lines: z.array(lineIn).max(200).default([]),
});
const changeIn = headerIn.extend({ lines: z.array(lineIn).min(1).max(200).optional() });
const placeIn = z.object({
  with: z.enum(['state', 'local']),
  stateTrackingNumber: z.string().trim().max(80).optional(),
  supplier: z.string().trim().max(200).optional(),
  logisticsOrderNumber: z.string().trim().max(80).optional(),
  eta: z.iso.datetime().optional(),
});
const statusIn = z.object({
  status: z.enum(['en_route', 'received']),
  eta: z.iso.datetime().optional(),
  arrivedAt: z.iso.datetime().optional(),
  stateTrackingNumber: z.string().trim().max(80).optional(),
});
const financeIn = z.object({
  reply: z.string().trim().min(3).max(2000),
  costEstimate: z.number().min(0).max(1_000_000_000).optional(),
});

const num = (v: string | number | null | undefined) =>
  v === null || v === undefined ? null : Number(v);

/** Which steps may follow which status; anything else is a 409 (RULE-14: nothing silent). */
const NEXT: Record<string, ResourceRequestStatus[]> = {
  submit: ['draft'],
  approve: ['submitted'],
  place: ['approved'],
  en_route: ['placed'],
  received: ['placed', 'en_route'],
  cancel: ['draft', 'submitted', 'approved', 'placed', 'en_route'],
  change: ['draft'],
  finance: ['draft', 'submitted', 'approved'],
};

export const resourceRequestRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const one = (trx: Trx, id: string) =>
    trx.selectFrom('cg.resource_request').selectAll().where('id', '=', id).executeTakeFirst();
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
  const threshold = async (trx: Trx) => {
    const v = await configValue<unknown>(trx, FINANCE_THRESHOLD_KEY);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  };
  /** Plan §13 question 5: finance must reply before placing when the cost reaches the threshold. */
  const financeNeeded = (r: Row, limit: number | null) =>
    limit !== null &&
    r.cost_estimate !== null &&
    Number(r.cost_estimate) >= limit &&
    r.finance_reply === null &&
    ['draft', 'submitted', 'approved'].includes(r.status);

  async function view(trx: Trx, r: Row, me: string): Promise<RequestOut> {
    const [lines, steps, ev, limit] = await Promise.all([
      trx
        .selectFrom('cg.resource_request_line')
        .selectAll()
        .where('request_id', '=', r.id)
        .orderBy('line_no')
        .execute(),
      trx
        .selectFrom('cg.resource_request_step')
        .selectAll()
        .where('request_id', '=', r.id)
        .orderBy('occurred_at')
        .orderBy('created_at')
        .execute(),
      trx.selectFrom('cg.event').select('name').where('id', '=', r.event_id).executeTakeFirst(),
      threshold(trx),
    ]);
    const who = await names(trx, [
      r.submitted_by,
      r.approved_by,
      ...steps.map((s: StepRow) => s.actor_account_id),
    ]);
    return {
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      eventId: r.event_id,
      eventName: ev?.name ?? null,
      requestNumber: r.request_number,
      status: r.status,
      priority: r.priority,
      supplyRequestId: r.supply_request_id,
      deliveryLocation: r.delivery_location,
      requestedByName: r.requested_by_name,
      requestedByPosition: r.requested_by_position,
      substitutes: r.substitutes,
      suggestedSources: r.suggested_sources,
      notes: r.notes,
      costEstimate: num(r.cost_estimate),
      financeReply: r.finance_reply,
      financeRepliedAt: iso(r.finance_replied_at),
      submittedAt: iso(r.submitted_at),
      submittedBy: r.submitted_by ? (who.get(r.submitted_by) ?? null) : null,
      submittedByYou: r.submitted_by === me,
      approvedAt: iso(r.approved_at),
      approvedBy: r.approved_by ? (who.get(r.approved_by) ?? null) : null,
      placedAt: iso(r.placed_at),
      placedWith: r.placed_with,
      stateTrackingNumber: r.state_tracking_number,
      supplier: r.supplier,
      logisticsOrderNumber: r.logistics_order_number,
      eta: iso(r.eta),
      arrivedAt: iso(r.arrived_at),
      receivedAt: iso(r.received_at),
      cancelledAt: iso(r.cancelled_at),
      financeReplyNeeded: financeNeeded(r, limit),
      lines: lines.map((l: LineRow) => ({
        lineNo: l.line_no,
        quantity: Number(l.quantity),
        unit: l.unit,
        kind: l.kind,
        type: l.type,
        description: l.description,
        eta: iso(l.eta),
        cost: num(l.cost),
      })),
      steps: steps.map((s: StepRow) => ({
        step: s.step,
        fromStatus: s.from_status,
        toStatus: s.to_status,
        reason: s.reason,
        stateTrackingNumber: s.state_tracking_number,
        occurredAt: iso(s.occurred_at)!,
        actorKind: s.actor_kind,
        actorName: s.actor_account_id ? (who.get(s.actor_account_id) ?? null) : null,
      })),
    };
  }

  async function writeStep(
    trx: Trx,
    r: Row,
    step: ResourceRequestStep,
    from: string | null,
    to: string | null,
    reason: string | null,
    actor: string,
    stateTrackingNumber: string | null = null,
  ) {
    await trx
      .insertInto('cg.resource_request_step')
      .values({
        tenant_id: r.tenant_id,
        request_id: r.id,
        step,
        from_status: from,
        to_status: to,
        reason,
        state_tracking_number: stateTrackingNumber,
        actor_account_id: actor,
        created_by: actor,
        updated_by: actor,
      })
      .execute();
  }

  async function replaceLines(
    trx: Trx,
    r: Row,
    lines: z.infer<typeof lineIn>[],
    actor: string,
  ): Promise<void> {
    await trx.deleteFrom('cg.resource_request_line').where('request_id', '=', r.id).execute();
    if (!lines.length) return;
    await trx
      .insertInto('cg.resource_request_line')
      .values(
        lines.map((l, i) => ({
          tenant_id: r.tenant_id,
          request_id: r.id,
          line_no: i + 1,
          quantity: l.quantity,
          unit: l.unit ?? null,
          kind: l.kind,
          type: l.type ?? null,
          description: l.description ?? null,
          eta: l.eta ? new Date(l.eta) : null,
          cost: l.cost ?? null,
          created_by: actor,
          updated_by: actor,
        })),
      )
      .execute();
  }

  /** The county's request number (block 3): per event, in order, under a lock on the event row. */
  async function nextNumber(trx: Trx, event: { id: string; intake_slug: string | null }) {
    const n = await trx
      .selectFrom('cg.resource_request')
      .select(sql<string>`count(*)`.as('n'))
      .where('event_id', '=', event.id)
      .executeTakeFirstOrThrow();
    const code = (event.intake_slug ?? event.id.slice(0, 8)).toUpperCase();
    return `${code}-RR-${String(Number(n.n) + 1).padStart(4, '0')}`;
  }

  const headerSet = (b: z.infer<typeof headerIn>) => ({
    ...(b.priority !== undefined ? { priority: b.priority } : {}),
    ...(b.deliveryLocation !== undefined ? { delivery_location: b.deliveryLocation || null } : {}),
    ...(b.requestedByPosition !== undefined
      ? { requested_by_position: b.requestedByPosition || null }
      : {}),
    ...(b.substitutes !== undefined ? { substitutes: b.substitutes || null } : {}),
    ...(b.suggestedSources !== undefined ? { suggested_sources: b.suggestedSources || null } : {}),
    ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
    ...(b.costEstimate !== undefined ? { cost_estimate: b.costEstimate } : {}),
  });

  const notAllowed = (status: string, step: string) =>
    new ApiError(
      409,
      'resource_request_state',
      `A ${status.replace('_', ' ')} request cannot be ${step}.`,
    );

  /** Loads the request and authorizes the action against it (event-scoped roles included). */
  async function gate(
    request: FastifyRequest,
    action: string,
    id: string,
    extra: { recordedBy?: string | null } = {},
  ): Promise<Row> {
    const s = account(request);
    const found = await request.tx((trx) => one(trx, id));
    if (!found || found.tenant_id !== s.tenantId) throw errors.notFound();
    await request.authorize(
      action,
      {
        type: 'resource_request',
        id: found.id,
        tenantId: found.tenant_id,
        eventId: found.event_id,
        ...(extra.recordedBy ? { recordedBy: extra.recordedBy } : {}),
      },
      { asNotFound: true },
    );
    return found;
  }

  app.get(
    '/resource-requests',
    {
      schema: {
        tags: ['resource requests'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          status: z.enum(STATUSES).optional(),
        }),
        response: { 200: z.array(requestOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const q = request.query;
      await request.authorize('resource_request.read', {
        type: 'resource_request',
        tenantId: s.tenantId,
        ...(q.eventId ? { eventId: q.eventId } : {}),
      });
      return request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.resource_request')
          .selectAll()
          .where('tenant_id', '=', s.tenantId)
          .orderBy(sql`case priority when 'urgent' then 0 when 'high' then 1 else 2 end`)
          .orderBy('updated_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.status) x = x.where('status', '=', q.status);
        const rows = await x.execute();
        const out: RequestOut[] = [];
        for (const r of rows) out.push(await view(trx, r, s.accountId));
        return out;
      });
    },
  );

  app.get(
    '/resource-requests/:id',
    { schema: { tags: ['resource requests'], params: uuidParam, response: { 200: requestOut } } },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'resource_request.read', request.params.id);
      return request.tx((trx) => view(trx, found, s.accountId));
    },
  );

  app.post(
    '/resource-requests',
    { schema: { tags: ['resource requests'], body: draftIn, response: { 201: requestOut } } },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('resource_request.write', {
        type: 'resource_request',
        tenantId: s.tenantId,
        eventId: b.eventId,
      });
      const out = await request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select(['id', 'intake_slug', 'status'])
          .where('id', '=', b.eventId)
          .where('tenant_id', '=', s.tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!event)
          throw errors.validation([{ name: 'eventId', message: 'an event of this organization' }]);
        if (event.status === 'closed')
          throw new ApiError(409, 'event_closed', 'This event is closed.');
        const me = await trx
          .selectFrom('cg.account')
          .select('display_name')
          .where('id', '=', s.accountId)
          .executeTakeFirstOrThrow();
        const position =
          b.requestedByPosition ??
          (
            await trx
              .selectFrom('cg.personnel')
              .select('operational_role')
              .where('account_id', '=', s.accountId)
              .where('status', '=', 'active')
              .executeTakeFirst()
          )?.operational_role ??
          null;
        const lines: z.infer<typeof lineIn>[] = [];
        let deliveryLocation = b.deliveryLocation ?? null;
        if (b.supplyRequestId) {
          // FL:FR-21: the site's supply request becomes the state request's lines.
          const sr = await trx
            .selectFrom('cg.supply_request')
            .selectAll()
            .where('id', '=', b.supplyRequestId)
            .where('tenant_id', '=', s.tenantId)
            .executeTakeFirst();
          if (!sr || sr.status === 'canceled')
            throw errors.validation([
              { name: 'supplyRequestId', message: 'an open supply request' },
            ]);
          const site = await trx
            .selectFrom('cg.site')
            .select('name')
            .where('id', '=', sr.site_id)
            .executeTakeFirst();
          deliveryLocation ??= site?.name ?? null;
          for (const l of sr.lines ?? [])
            lines.push({ quantity: Number(l.quantity), unit: l.unit, kind: l.name });
        }
        lines.push(...b.lines);
        const r = await trx
          .insertInto('cg.resource_request')
          .values({
            tenant_id: s.tenantId,
            event_id: event.id,
            request_number: await nextNumber(trx, event),
            priority: b.priority ?? 'high',
            supply_request_id: b.supplyRequestId ?? null,
            delivery_location: deliveryLocation,
            requested_by_name: me.display_name,
            requested_by_position: position,
            substitutes: b.substitutes || null,
            suggested_sources: b.suggestedSources || null,
            notes: b.notes || null,
            cost_estimate: b.costEstimate ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await replaceLines(trx, r, lines, s.accountId);
        await writeStep(trx, r, 'drafted', null, 'draft', null, s.accountId);
        await request.audit(trx, {
          action: 'resource_request.drafted',
          targetType: 'resource_request',
          targetId: r.id,
          targetVersion: r.version,
          changes: {
            fields: [
              { name: 'request_number', to: r.request_number },
              { name: 'event_id', to: r.event_id },
              { name: 'lines', to: String(lines.length) },
            ],
          },
        });
        return view(trx, r, s.accountId);
      });
      return reply.code(201).send(out);
    },
  );

  app.patch(
    '/resource-requests/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['resource requests'],
        params: uuidParam,
        body: changeIn,
        response: { 200: requestOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'resource_request.write', request.params.id);
      if (!NEXT['change']!.includes(found.status)) throw notAllowed(found.status, 'changed');
      const expected = request.expectedVersion();
      const b = request.body;
      return request.tx(async (trx) => {
        const set = headerSet(b);
        const updated = assertUpdated(
          await trx
            .updateTable('cg.resource_request')
            .set({ ...set, updated_by: s.accountId })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        if (b.lines) await replaceLines(trx, updated, b.lines, s.accountId);
        await writeStep(trx, updated, 'changed', found.status, found.status, null, s.accountId);
        await request.audit(trx, {
          action: 'resource_request.changed',
          targetType: 'resource_request',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: {
            fields: [
              ...Object.keys(set).map((name) => ({ name })),
              ...(b.lines ? [{ name: 'lines', to: String(b.lines.length) }] : []),
            ],
          },
        });
        return view(trx, updated, s.accountId);
      });
    },
  );

  /** Finance's reply (block 13) and the cost; allowed until the order is placed. */
  app.post(
    '/resource-requests/:id/finance',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['resource requests'],
        params: uuidParam,
        body: financeIn,
        response: { 200: requestOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'resource_request.write', request.params.id);
      if (!NEXT['finance']!.includes(found.status))
        throw notAllowed(found.status, 'answered by finance');
      const expected = request.expectedVersion();
      const b = request.body;
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.resource_request')
            .set({
              finance_reply: b.reply,
              finance_replied_at: new Date(),
              finance_replied_by: s.accountId,
              ...(b.costEstimate !== undefined ? { cost_estimate: b.costEstimate } : {}),
              updated_by: s.accountId,
            })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await writeStep(
          trx,
          updated,
          'finance_replied',
          found.status,
          found.status,
          b.reply,
          s.accountId,
        );
        await request.audit(trx, {
          action: 'resource_request.finance_replied',
          targetType: 'resource_request',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: [{ name: 'finance_reply' }] },
        });
        return view(trx, updated, s.accountId);
      });
    },
  );

  /**
   * A transition with a reason: submit (the requester), approve (a second person as section
   * chief), place (logistics), cancel. The confirmation and reason come with the request
   * (RULE-14); the engine refuses approval by the submitter (G4) and the table does too.
   */
  for (const op of ['submit', 'approve', 'cancel'] as const)
    app.post(
      `/resource-requests/:id/${op}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['resource requests'], params: uuidParam, response: { 200: requestOut } },
      },
      async (request) => {
        const s = account(request);
        const pre = await request.tx((trx) => one(trx, request.params.id));
        if (!pre || pre.tenant_id !== s.tenantId) throw errors.notFound();
        const found = await gate(request, `resource_request.${op}`, request.params.id, {
          recordedBy: op === 'approve' ? pre.submitted_by : null,
        });
        if (!NEXT[op]!.includes(found.status))
          throw notAllowed(found.status, op === 'cancel' ? 'cancelled' : `${op}d`);
        const { reason } = request.confirmation();
        const expected = request.expectedVersion();
        const now = new Date();
        const to: ResourceRequestStatus =
          op === 'submit' ? 'submitted' : op === 'approve' ? 'approved' : 'cancelled';
        const set =
          op === 'submit'
            ? { status: to, submitted_at: now, submitted_by: s.accountId }
            : op === 'approve'
              ? { status: to, approved_at: now, approved_by: s.accountId }
              : { status: to, cancelled_at: now, cancelled_by: s.accountId };
        return request.tx(async (trx) => {
          const updated = assertUpdated(
            await trx
              .updateTable('cg.resource_request')
              .set({ ...set, updated_by: s.accountId })
              .where('id', '=', found.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            found,
          );
          const step: ResourceRequestStep =
            op === 'submit' ? 'submitted' : op === 'approve' ? 'approved' : 'cancelled';
          await writeStep(trx, updated, step, found.status, to, reason, s.accountId);
          await request.audit(trx, {
            action: `resource_request.${step}`,
            targetType: 'resource_request',
            targetId: updated.id,
            targetVersion: updated.version,
            reason,
            changes: { fields: [{ name: 'status', from: found.status, to }] },
          });
          return view(trx, updated, s.accountId);
        });
      },
    );

  /** Logistics places the order with the state (recording its number) or locally (block 12). */
  app.post(
    '/resource-requests/:id/place',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['resource requests'],
        params: uuidParam,
        body: placeIn,
        response: { 200: requestOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'resource_request.place', request.params.id);
      if (!NEXT['place']!.includes(found.status)) throw notAllowed(found.status, 'placed');
      const { reason } = request.confirmation();
      const expected = request.expectedVersion();
      const b = request.body;
      return request.tx(async (trx) => {
        if (financeNeeded(found, await threshold(trx)))
          throw new ApiError(
            409,
            'finance_reply_required',
            "This request's cost reaches the county's threshold: finance replies before it is placed.",
          );
        const updated = assertUpdated(
          await trx
            .updateTable('cg.resource_request')
            .set({
              status: 'placed',
              placed_at: new Date(),
              placed_by: s.accountId,
              placed_with: b.with,
              state_tracking_number: b.stateTrackingNumber || null,
              supplier: b.supplier || null,
              logistics_order_number: b.logisticsOrderNumber || null,
              eta: b.eta ? new Date(b.eta) : null,
              updated_by: s.accountId,
            })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await writeStep(
          trx,
          updated,
          'placed',
          found.status,
          'placed',
          reason,
          s.accountId,
          b.stateTrackingNumber || null,
        );
        await request.audit(trx, {
          action: 'resource_request.placed',
          targetType: 'resource_request',
          targetId: updated.id,
          targetVersion: updated.version,
          reason,
          changes: {
            fields: [
              { name: 'status', from: found.status, to: 'placed' },
              { name: 'placed_with', to: b.with },
            ],
          },
        });
        return view(trx, updated, s.accountId);
      });
    },
  );

  /** En route and received, with the arrival time and the state's number when it comes late. */
  app.post(
    '/resource-requests/:id/status',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['resource requests'],
        params: uuidParam,
        body: statusIn,
        response: { 200: requestOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'resource_request.write', request.params.id);
      const b = request.body;
      if (!NEXT[b.status]!.includes(found.status))
        throw notAllowed(found.status, b.status === 'en_route' ? 'marked en route' : 'received');
      const expected = request.expectedVersion();
      const now = new Date();
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.resource_request')
            .set({
              status: b.status,
              ...(b.eta ? { eta: new Date(b.eta) } : {}),
              ...(b.stateTrackingNumber ? { state_tracking_number: b.stateTrackingNumber } : {}),
              ...(b.status === 'received'
                ? {
                    arrived_at: b.arrivedAt ? new Date(b.arrivedAt) : now,
                    received_at: now,
                    received_by: s.accountId,
                  }
                : {}),
              updated_by: s.accountId,
            })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await writeStep(
          trx,
          updated,
          b.status,
          found.status,
          b.status,
          null,
          s.accountId,
          b.stateTrackingNumber ?? null,
        );
        await request.audit(trx, {
          action: `resource_request.${b.status}`,
          targetType: 'resource_request',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: [{ name: 'status', from: found.status, to: b.status }] },
        });
        return view(trx, updated, s.accountId);
      });
    },
  );
};
