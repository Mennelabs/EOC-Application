/**
 * Break-glass access (SEC-08, plan §8.2): time-boxed, justified, read-only,
 * and the tenant's security contact is told. Starting a session is a
 * consequential action; while one is active the engine allows reads within
 * the tenant, audits each as restricted, and freezes permission changes (G6).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { enqueueOutbox, iso, listQuery, stamped, uuidParam } from './helpers.ts';

const sessionOut = z.object({
  ...stamped,
  accountId: z.uuid(),
  reason: z.string(),
  startedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  notifiedAt: z.iso.datetime().nullable(),
});

type Row = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  account_id: string;
  reason: string;
  started_at: Date;
  expires_at: Date;
  ended_at: Date | null;
  notified_at: Date | null;
};

const toSession = (r: Row): z.infer<typeof sessionOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  accountId: r.account_id,
  reason: r.reason,
  startedAt: iso(r.started_at)!,
  expiresAt: iso(r.expires_at)!,
  endedAt: iso(r.ended_at),
  notifiedAt: iso(r.notified_at),
});

export const breakGlassRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/break-glass',
    {
      schema: {
        tags: ['break-glass'],
        querystring: listQuery,
        response: { 200: z.array(sessionOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('break_glass.read', {
        type: 'break_glass_session',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.break_glass_session')
          .selectAll()
          .orderBy('started_at', 'desc')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map(toSession);
    },
  );

  app.post(
    '/break-glass',
    {
      config: { idempotent: true },
      schema: {
        tags: ['break-glass'],
        body: z.object({
          reason: z.string().min(20).max(1000),
          hours: z.number().int().min(1).max(24).default(4),
        }),
        response: { 201: sessionOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      if (s.breakGlass) throw errors.conflict({ activeSessionId: s.breakGlass.id });
      await request.authorize('break_glass.start', {
        type: 'break_glass_session',
        tenantId: s.tenantId,
      });
      const { reason } = request.confirmation();
      const started = new Date();
      const expires = new Date(started.getTime() + request.body.hours * 3600_000);
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.break_glass_session')
          .values({
            tenant_id: s.tenantId,
            account_id: s.accountId,
            reason: request.body.reason,
            started_at: started,
            expires_at: expires,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'break_glass.start',
          targetType: 'break_glass_session',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: { fields: [{ name: 'expires_at', to: expires.toISOString() }] },
          reason: `${request.body.reason} | confirmation: ${reason ?? ''}`,
        });
        // The worker emails the tenant security contact and records notified_at (SEC-08).
        await enqueueOutbox(
          trx,
          s.tenantId,
          'break_glass.started',
          { sessionId: inserted.id, accountId: s.accountId, expiresAt: expires.toISOString() },
          request.executionId,
        );
        return inserted;
      });
      return reply.code(201).send(toSession(row));
    },
  );

  app.post(
    '/break-glass/:id/end',
    {
      config: { requiresVersion: true },
      schema: { tags: ['break-glass'], params: uuidParam, response: { 200: sessionOut } },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.break_glass_session')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      // Your own session ends on your say-so; anyone else's needs the end grant.
      if (current.account_id !== s.accountId) {
        await request.authorize(
          'break_glass.end',
          { type: 'break_glass_session', id: current.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
      }
      if (current.ended_at) throw errors.conflict(toSession(current));
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.break_glass_session')
            .set({ ended_at: new Date(), ended_by: s.accountId, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toSession(current),
        );
        await request.audit(trx, {
          action: 'break_glass.end',
          targetType: 'break_glass_session',
          targetId: row.id,
          targetVersion: row.version,
        });
        return row;
      });
      return toSession(updated);
    },
  );
};
