/**
 * FL-16: a private way for a worker to ask for peer support.
 *
 * The worker asks from the field app: how to be reached (a call, a text or in
 * person) and when (now or after the shift). No words and no reason are
 * kept. The worker sees and can withdraw their own request.
 *
 * Only the peer-support role reads requests: the action is granted to the
 * crisis-counselor template, and the request itself is counseling data that
 * the engine masks for every other template (ADM-05 guardrail 7), so a county
 * that grants the action elsewhere still shows nothing. The worker's lead,
 * dispatch and coordinators never see a request; nothing about it reaches the
 * board, the roster, the activity log or the team's messages. A closed request
 * is deleted after the `peer_support` retention period (30 days by default).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { FieldDescriptor } from '@cg/authz';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, uuidParam } from './helpers.ts';

const REACH_BY = ['call', 'text', 'in_person'] as const;
const REACH_WHEN = ['now', 'after_shift'] as const;

/** The request is counseling data: only the peer-support template sees it (G7). */
const REQUEST_FIELDS: FieldDescriptor[] = [
  { name: 'request', category: 'counseling', classification: 'restricted' },
];

const mineOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  reachBy: z.enum(REACH_BY),
  reachWhen: z.enum(REACH_WHEN),
  status: z.enum(['open', 'contacted', 'closed']),
  requestedAt: z.iso.datetime(),
  contactedAt: z.iso.datetime().nullable(),
});

const requestOut = mineOut.extend({
  name: z.string(),
  agency: z.string().nullable(),
  /** Only when they asked for a call or a text, from their own roster contact. */
  phone: z.string().nullable(),
  eventName: z.string().nullable(),
  closedAt: z.iso.datetime().nullable(),
});

interface Row {
  id: string;
  version: number;
  reach_by: (typeof REACH_BY)[number];
  reach_when: (typeof REACH_WHEN)[number];
  status: 'open' | 'contacted' | 'closed';
  requested_at: Date;
  contacted_at: Date | null;
  closed_at: Date | null;
}

const toMine = (r: Row): z.infer<typeof mineOut> => ({
  id: r.id,
  version: r.version,
  reachBy: r.reach_by,
  reachWhen: r.reach_when,
  status: r.status,
  requestedAt: iso(r.requested_at)!,
  contactedAt: iso(r.contacted_at),
});

export const peerSupportRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  async function ownPerson(request: FastifyRequest) {
    const s = account(request);
    const row = await request.tx((trx) =>
      trx
        .selectFrom('cg.personnel')
        .select(['id', 'tenant_id'])
        .where('account_id', '=', s.accountId)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    if (!row)
      throw new ApiError(
        409,
        'no_personnel_record',
        'Your account is not linked to a personnel record; ask your coordinator.',
      );
    return row;
  }

  /** The peer-support role only: the action and the counseling category both. */
  async function asPeerSupport(request: FastifyRequest, action: string) {
    const s = account(request);
    const decision = await request.authorize(action, {
      type: 'peer_support_request',
      tenantId: s.tenantId,
      fields: REQUEST_FIELDS,
    });
    if (!decision.fields.includes('request')) throw errors.forbidden();
    return s;
  }

  // ------------------------------------------------------------ the worker
  app.post(
    '/peer-support',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          clientUuid: z.uuid(),
          reachBy: z.enum(REACH_BY),
          reachWhen: z.enum(REACH_WHEN),
        }),
        response: { 201: mineOut, 200: mineOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('peer_support.request', {
        type: 'peer_support_request',
        tenantId: s.tenantId,
      });
      const person = await ownPerson(request);
      const b = request.body;
      const { row, created } = await request.tx(async (trx) => {
        const replay = await trx
          .selectFrom('cg.peer_support_request')
          .selectAll()
          .where('client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (replay) {
          if (replay.personnel_id !== person.id) throw errors.notFound();
          return { row: replay, created: false };
        }
        // One request at a time: asking again while one is open answers with that one.
        const open = await trx
          .selectFrom('cg.peer_support_request')
          .selectAll()
          .where('personnel_id', '=', person.id)
          .where('status', '<>', 'closed')
          .executeTakeFirst();
        if (open) return { row: open, created: false };
        const checkIn = await trx
          .selectFrom('cg.check_in')
          .select('event_id')
          .where('personnel_id', '=', person.id)
          .where('ended_at', 'is', null)
          .executeTakeFirst();
        const inserted = await trx
          .insertInto('cg.peer_support_request')
          .values({
            tenant_id: person.tenant_id,
            personnel_id: person.id,
            event_id: checkIn?.event_id ?? null,
            client_uuid: b.clientUuid,
            reach_by: b.reachBy,
            reach_when: b.reachWhen,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        // Audited like every write; what was asked stays in the request, not the audit.
        await request.audit(trx, {
          action: 'peer_support.request',
          targetType: 'peer_support_request',
          targetId: inserted.id,
          targetVersion: inserted.version,
        });
        return { row: inserted, created: true };
      });
      return reply.code(created ? 201 : 200).send(toMine(row));
    },
  );

  app.get(
    '/peer-support/mine',
    { schema: { tags: ['field'], response: { 200: z.array(mineOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('peer_support.request', {
        type: 'peer_support_request',
        tenantId: s.tenantId,
      });
      const person = await ownPerson(request);
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.peer_support_request')
          .selectAll()
          .where('personnel_id', '=', person.id)
          .where('status', '<>', 'closed')
          .orderBy('requested_at', 'desc')
          .execute(),
      );
      return rows.map(toMine);
    },
  );

  app.post(
    '/peer-support/:id/withdraw',
    {
      config: { requiresVersion: true },
      schema: { tags: ['field'], params: uuidParam, response: { 200: mineOut } },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('peer_support.request', {
        type: 'peer_support_request',
        tenantId: s.tenantId,
      });
      const person = await ownPerson(request);
      const expected = request.expectedVersion();
      const row = await request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.peer_support_request')
          .selectAll()
          .where('id', '=', request.params.id)
          .where('personnel_id', '=', person.id)
          .executeTakeFirst();
        if (!current) throw errors.notFound();
        if (current.status === 'closed') return current;
        const updated = assertUpdated(
          await trx
            .updateTable('cg.peer_support_request')
            .set({
              status: 'closed',
              closed_at: new Date(),
              closed_by: s.accountId,
              closed_by_requester: true,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toMine(current),
        );
        await request.audit(trx, {
          action: 'peer_support.request',
          targetType: 'peer_support_request',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: [{ name: 'status', to: 'closed' }] },
        });
        return updated;
      });
      return toMine(row);
    },
  );

  // ------------------------------------------------- the peer-support role
  app.get(
    '/peer-support',
    {
      schema: {
        tags: ['field'],
        querystring: z.object({ include: z.enum(['open', 'all']).default('open') }),
        response: { 200: z.array(requestOut) },
      },
    },
    async (request) => {
      await asPeerSupport(request, 'peer_support.read');
      const rows = await request.tx(async (trx) => {
        let q = trx
          .selectFrom('cg.peer_support_request as r')
          .innerJoin('cg.personnel as p', 'p.id', 'r.personnel_id')
          .leftJoin('cg.event as e', 'e.id', 'r.event_id')
          .select([
            'r.id',
            'r.version',
            'r.reach_by',
            'r.reach_when',
            'r.status',
            'r.requested_at',
            'r.contacted_at',
            'r.closed_at',
            'p.name',
            'p.agency',
            'p.contact_enc',
            'p.tenant_id',
            'e.name as event_name',
          ])
          .orderBy('r.requested_at');
        if (request.query.include === 'open') q = q.where('r.status', '<>', 'closed');
        const found = await q.execute();
        if (found.length)
          await request.audit(trx, {
            action: 'peer_support.read',
            targetType: 'peer_support_request',
            targetId: found.length === 1 ? found[0]!.id : `list:${found.length}`,
            classificationRead: ['counseling'],
          });
        return found;
      });
      return Promise.all(
        rows.map(async (r) => {
          let phone: string | null = null;
          if (r.reach_by !== 'in_person' && r.contact_enc) {
            const contact = JSON.parse(
              await app.fieldCrypto.decrypt(r.tenant_id, r.contact_enc),
            ) as { phone?: string };
            phone = contact.phone ?? null;
          }
          return {
            ...toMine(r),
            name: r.name,
            agency: r.agency,
            phone,
            eventName: r.event_name,
            closedAt: iso(r.closed_at),
          };
        }),
      );
    },
  );

  for (const [path, to] of [
    ['contacted', 'contacted'],
    ['close', 'closed'],
  ] as const) {
    app.post(
      `/peer-support/:id/${path}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['field'], params: uuidParam, response: { 200: mineOut } },
      },
      async (request) => {
        const s = await asPeerSupport(request, 'peer_support.update');
        const expected = request.expectedVersion();
        const row = await request.tx(async (trx) => {
          const current = await trx
            .selectFrom('cg.peer_support_request')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!current) throw errors.notFound();
          if (current.status === 'closed') throw errors.conflict(toMine(current));
          const now = new Date();
          const updated = assertUpdated(
            await trx
              .updateTable('cg.peer_support_request')
              .set({
                status: to,
                ...(to === 'contacted'
                  ? { contacted_at: now, contacted_by: s.accountId }
                  : { closed_at: now, closed_by: s.accountId }),
                updated_by: s.accountId,
              })
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            toMine(current),
          );
          await request.audit(trx, {
            action: 'peer_support.update',
            targetType: 'peer_support_request',
            targetId: updated.id,
            targetVersion: updated.version,
            changes: { fields: [{ name: 'status', to }] },
          });
          return updated;
        });
        return toMine(row);
      },
    );
  }
};
