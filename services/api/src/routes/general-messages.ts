/**
 * General messages (CON-13; the ICS 213 blocks; layer-8 plan §4). A section
 * drafts a message to a named position, a second person approves it (block
 * 7; never the writer: ADM-05 G4, refused by the engine and by the table),
 * it is sent, and the addressee's reply is recorded (blocks 8 and 9). A
 * message sent to the field through "Messages to the field" is linked by
 * its field message. Names and positions are staff's, never a resident's.
 * Versioned and audited (FR-00.*).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, GeneralMessageStatus } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type Row = Selectable<Database['cg.general_message']>;

const STATUSES = ['draft', 'approved', 'sent', 'replied', 'cancelled'] as const;
const messageOut = z.object({
  ...stamped,
  eventId: z.uuid(),
  messageNumber: z.string(),
  status: z.enum(STATUSES),
  to: z.object({ name: z.string(), position: z.string().nullable() }),
  from: z.object({ name: z.string(), position: z.string().nullable() }),
  subject: z.string(),
  body: z.string(),
  writtenBy: z.string().nullable(),
  writtenByYou: z.boolean(),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  sentAt: z.iso.datetime().nullable(),
  fieldMessageId: z.uuid().nullable(),
  reply: z.string().nullable(),
  repliedBy: z.object({ name: z.string(), position: z.string().nullable() }).nullable(),
  repliedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});
type MessageOut = z.infer<typeof messageOut>;

const NEXT: Record<string, GeneralMessageStatus[]> = {
  change: ['draft'],
  approve: ['draft'],
  send: ['approved'],
  reply: ['sent'],
  cancel: ['draft', 'approved'],
};

/** The signed-in person's name and ICS position (their roster position when they have one). */
export async function signerOf(
  trx: Trx,
  accountId: string,
): Promise<{ name: string; position: string | null }> {
  const me = await trx
    .selectFrom('cg.account')
    .select('display_name')
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();
  const p = await trx
    .selectFrom('cg.personnel')
    .select('operational_role')
    .where('account_id', '=', accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return { name: me.display_name, position: p?.operational_role ?? null };
}

export const generalMessageRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const one = (trx: Trx, id: string) =>
    trx.selectFrom('cg.general_message').selectAll().where('id', '=', id).executeTakeFirst();
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
  async function view(trx: Trx, r: Row, me: string): Promise<MessageOut> {
    const who = await names(trx, [r.created_by, r.approved_by]);
    return {
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      eventId: r.event_id,
      messageNumber: r.message_number,
      status: r.status,
      to: { name: r.to_name, position: r.to_position },
      from: { name: r.from_name, position: r.from_position },
      subject: r.subject,
      body: r.body,
      writtenBy: r.created_by ? (who.get(r.created_by) ?? null) : null,
      writtenByYou: r.created_by === me,
      approvedBy: r.approved_by ? (who.get(r.approved_by) ?? null) : null,
      approvedAt: iso(r.approved_at),
      sentAt: iso(r.sent_at),
      fieldMessageId: r.field_message_id,
      reply: r.reply,
      repliedBy: r.reply_by_name ? { name: r.reply_by_name, position: r.reply_by_position } : null,
      repliedAt: iso(r.replied_at),
      cancelledAt: iso(r.cancelled_at),
    };
  }
  async function gate(
    request: FastifyRequest,
    action: string,
    id: string,
    recordedBy: string | null = null,
  ): Promise<Row> {
    const s = account(request);
    const found = await request.tx((trx) => one(trx, id));
    if (!found || found.tenant_id !== s.tenantId) throw errors.notFound();
    await request.authorize(
      action,
      {
        type: 'general_message',
        id: found.id,
        tenantId: found.tenant_id,
        eventId: found.event_id,
        ...(recordedBy ? { recordedBy } : {}),
      },
      { asNotFound: true },
    );
    return found;
  }
  const notAllowed = (status: string, step: string) =>
    new ApiError(409, 'general_message_state', `A ${status} message cannot be ${step}.`);

  app.get(
    '/general-messages',
    {
      schema: {
        tags: ['ics forms'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          status: z.enum(STATUSES).optional(),
        }),
        response: { 200: z.array(messageOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const q = request.query;
      await request.authorize('general_message.read', {
        type: 'general_message',
        tenantId: s.tenantId,
        ...(q.eventId ? { eventId: q.eventId } : {}),
      });
      return request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.general_message')
          .selectAll()
          .where('tenant_id', '=', s.tenantId)
          .orderBy('created_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.status) x = x.where('status', '=', q.status);
        const out: MessageOut[] = [];
        for (const r of await x.execute()) out.push(await view(trx, r, s.accountId));
        return out;
      });
    },
  );

  app.get(
    '/general-messages/:id',
    { schema: { tags: ['ics forms'], params: uuidParam, response: { 200: messageOut } } },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'general_message.read', request.params.id);
      return request.tx((trx) => view(trx, found, s.accountId));
    },
  );

  const draftIn = z.object({
    eventId: z.uuid(),
    to: z.object({
      name: z.string().trim().min(1).max(120),
      position: z.string().trim().max(120).optional(),
    }),
    fromPosition: z.string().trim().max(120).optional(),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
  });

  app.post(
    '/general-messages',
    { schema: { tags: ['ics forms'], body: draftIn, response: { 201: messageOut } } },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('general_message.write', {
        type: 'general_message',
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
        const n = await trx
          .selectFrom('cg.general_message')
          .select(sql<string>`count(*)`.as('n'))
          .where('event_id', '=', event.id)
          .executeTakeFirstOrThrow();
        const code = (event.intake_slug ?? event.id.slice(0, 8)).toUpperCase();
        const me = await signerOf(trx, s.accountId);
        const r = await trx
          .insertInto('cg.general_message')
          .values({
            tenant_id: s.tenantId,
            event_id: event.id,
            message_number: `${code}-GM-${String(Number(n.n) + 1).padStart(4, '0')}`,
            to_name: b.to.name,
            to_position: b.to.position || null,
            from_name: me.name,
            from_position: b.fromPosition || me.position,
            subject: b.subject,
            body: b.body,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'general_message.drafted',
          targetType: 'general_message',
          targetId: r.id,
          targetVersion: r.version,
          changes: { fields: [{ name: 'message_number', to: r.message_number }] },
        });
        return view(trx, r, s.accountId);
      });
      return reply.code(201).send(out);
    },
  );

  app.patch(
    '/general-messages/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['ics forms'],
        params: uuidParam,
        body: draftIn.omit({ eventId: true }).partial(),
        response: { 200: messageOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'general_message.write', request.params.id);
      if (!NEXT['change']!.includes(found.status)) throw notAllowed(found.status, 'changed');
      const expected = request.expectedVersion();
      const b = request.body;
      const set = {
        ...(b.to ? { to_name: b.to.name, to_position: b.to.position || null } : {}),
        ...(b.fromPosition !== undefined ? { from_position: b.fromPosition || null } : {}),
        ...(b.subject !== undefined ? { subject: b.subject } : {}),
        ...(b.body !== undefined ? { body: b.body } : {}),
      };
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.general_message')
            .set({ ...set, updated_by: s.accountId })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await request.audit(trx, {
          action: 'general_message.changed',
          targetType: 'general_message',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: Object.keys(set).map((name) => ({ name })) },
        });
        return view(trx, updated, s.accountId);
      });
    },
  );

  /** Approve (block 7): a second person, with a reason; cancel: a draft or an approved message. */
  for (const op of ['approve', 'cancel'] as const)
    app.post(
      `/general-messages/:id/${op}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['ics forms'], params: uuidParam, response: { 200: messageOut } },
      },
      async (request) => {
        const s = account(request);
        const pre = await request.tx((trx) => one(trx, request.params.id));
        if (!pre || pre.tenant_id !== s.tenantId) throw errors.notFound();
        const found = await gate(
          request,
          op === 'approve' ? 'general_message.approve' : 'general_message.write',
          request.params.id,
          op === 'approve' ? pre.created_by : null,
        );
        if (!NEXT[op]!.includes(found.status))
          throw notAllowed(found.status, op === 'approve' ? 'approved' : 'cancelled');
        const { reason } = request.confirmation();
        const expected = request.expectedVersion();
        const now = new Date();
        const set =
          op === 'approve'
            ? { status: 'approved' as const, approved_at: now, approved_by: s.accountId }
            : { status: 'cancelled' as const, cancelled_at: now, cancelled_by: s.accountId };
        return request.tx(async (trx) => {
          const updated = assertUpdated(
            await trx
              .updateTable('cg.general_message')
              .set({ ...set, updated_by: s.accountId })
              .where('id', '=', found.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            found,
          );
          await request.audit(trx, {
            action: `general_message.${op === 'approve' ? 'approved' : 'cancelled'}`,
            targetType: 'general_message',
            targetId: updated.id,
            targetVersion: updated.version,
            reason,
            changes: { fields: [{ name: 'status', from: found.status, to: set.status }] },
          });
          return view(trx, updated, s.accountId);
        });
      },
    );

  /** Send: hands the approved message over; a field message already sent may be linked. */
  app.post(
    '/general-messages/:id/send',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['ics forms'],
        params: uuidParam,
        body: z.object({ fieldMessageId: z.uuid().optional() }).default({}),
        response: { 200: messageOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'general_message.send', request.params.id);
      if (!NEXT['send']!.includes(found.status)) throw notAllowed(found.status, 'sent');
      const { reason } = request.confirmation();
      const expected = request.expectedVersion();
      const b = request.body;
      return request.tx(async (trx) => {
        if (b.fieldMessageId) {
          const fm = await trx
            .selectFrom('cg.field_message')
            .select('id')
            .where('id', '=', b.fieldMessageId)
            .where('tenant_id', '=', s.tenantId)
            .where('event_id', '=', found.event_id)
            .executeTakeFirst();
          if (!fm)
            throw errors.validation([
              { name: 'fieldMessageId', message: 'a field message of this event' },
            ]);
        }
        const updated = assertUpdated(
          await trx
            .updateTable('cg.general_message')
            .set({
              status: 'sent',
              sent_at: new Date(),
              sent_by: s.accountId,
              field_message_id: b.fieldMessageId ?? null,
              updated_by: s.accountId,
            })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await request.audit(trx, {
          action: 'general_message.sent',
          targetType: 'general_message',
          targetId: updated.id,
          targetVersion: updated.version,
          reason,
          changes: { fields: [{ name: 'status', from: found.status, to: 'sent' }] },
        });
        return view(trx, updated, s.accountId);
      });
    },
  );

  /** The reply (blocks 8 and 9), recorded by whoever answers for the addressee. */
  app.post(
    '/general-messages/:id/reply',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['ics forms'],
        params: uuidParam,
        body: z.object({
          reply: z.string().trim().min(1).max(4000),
          byPosition: z.string().trim().max(120).optional(),
        }),
        response: { 200: messageOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await gate(request, 'general_message.write', request.params.id);
      if (!NEXT['reply']!.includes(found.status)) throw notAllowed(found.status, 'replied to');
      const expected = request.expectedVersion();
      const b = request.body;
      return request.tx(async (trx) => {
        const me = await signerOf(trx, s.accountId);
        const updated = assertUpdated(
          await trx
            .updateTable('cg.general_message')
            .set({
              status: 'replied',
              reply: b.reply,
              reply_by_name: me.name,
              reply_by_position: b.byPosition || me.position,
              replied_at: new Date(),
              replied_by: s.accountId,
              updated_by: s.accountId,
            })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await request.audit(trx, {
          action: 'general_message.replied',
          targetType: 'general_message',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: [{ name: 'status', from: found.status, to: 'replied' }] },
        });
        return view(trx, updated, s.accountId);
      });
    },
  );
};
