/**
 * The equity dashboard (layer-6 task G; EQ-11, EQ-12, EQ-13, CON-07): the
 * figures by tract, income band and group, with every count from 1 to 10
 * hidden, and the alerts the worker raised with their suggested outreach.
 * Staff acknowledge an alert by recording the outreach taken; the alert
 * stays until the condition no longer holds. Counts only, never a person.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { equityData } from '@cg/reporting';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { enqueueOutbox, iso, uuidParam } from './helpers.ts';

const alertOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  kind: z.enum(['coverage', 'review_gap', 'help_gap']),
  subjectKind: z.enum(['tract', 'income_band', 'tenure', 'language', 'channel']),
  subject: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  threshold: z.number(),
  outreach: z.string(),
  raisedAt: z.iso.datetime(),
  clearedAt: z.iso.datetime().nullable(),
  acknowledgedBy: z.string().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  actionTaken: z.string().nullable(),
});

type AlertRow = {
  id: string;
  version: number;
  kind: 'coverage' | 'review_gap' | 'help_gap';
  subject_kind: 'tract' | 'income_band' | 'tenure' | 'language' | 'channel';
  subject: string;
  label: string;
  value: string | null;
  threshold: string;
  outreach: string;
  raised_at: Date;
  cleared_at: Date | null;
  acknowledged_at: Date | null;
  action_taken: string | null;
  acknowledged_name?: string | null;
};
const alertView = (r: AlertRow): z.infer<typeof alertOut> => ({
  id: r.id,
  version: r.version,
  kind: r.kind,
  subjectKind: r.subject_kind,
  subject: r.subject,
  label: r.label,
  value: r.value === null ? null : Number(r.value),
  threshold: Number(r.threshold),
  outreach: r.outreach,
  raisedAt: iso(r.raised_at)!,
  clearedAt: iso(r.cleared_at),
  acknowledgedBy: r.acknowledged_name ?? null,
  acknowledgedAt: iso(r.acknowledged_at),
  actionTaken: r.action_taken,
});

export const equityRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.get(
    '/events/:id/equity',
    { schema: { tags: ['equity'], params: uuidParam } },
    async (request) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('equity.read', { type: 'equity', tenantId: s.tenantId, eventId });
      return request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select(['id', 'tenant_id'])
          .where('id', '=', eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        const data = await equityData(trx, event.tenant_id, eventId);
        const alerts = await trx
          .selectFrom('cg.equity_alert as a')
          .leftJoin('cg.account as ac', 'ac.id', 'a.acknowledged_by')
          .selectAll('a')
          .select('ac.display_name as acknowledged_name')
          .where('a.event_id', '=', eventId)
          .where((eb) =>
            eb.or([
              eb('a.cleared_at', 'is', null),
              eb('a.cleared_at', '>', new Date(Date.now() - 7 * 86_400_000)),
            ]),
          )
          .orderBy('a.cleared_at', 'desc')
          .orderBy('a.raised_at', 'desc')
          .execute();
        return { ...data, alerts: alerts.map((a) => alertView(a as AlertRow)) };
      });
    },
  );

  // "Check now": the worker works the figures out again for this event and records the flags.
  app.post(
    '/events/:id/equity/evaluate',
    {
      schema: {
        tags: ['equity'],
        params: uuidParam,
        response: { 202: z.object({ queued: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('equity.act', { type: 'equity', tenantId: s.tenantId, eventId });
      await request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select(['id', 'tenant_id'])
          .where('id', '=', eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        await enqueueOutbox(
          trx,
          event.tenant_id,
          'equity.evaluate',
          { eventId },
          request.executionId,
        );
      });
      return reply.code(202).send({ queued: true });
    },
  );

  app.post(
    '/equity-alerts/:id/acknowledge',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['equity'],
        params: uuidParam,
        body: z.object({
          /** The outreach taken or planned, without names (EQ-11). */
          actionTaken: z.string().trim().min(5).max(1000),
        }),
        response: { 200: alertOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.equity_alert')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'equity.act',
        { type: 'equity', id: current.id, tenantId: s.tenantId, eventId: current.event_id },
        { asNotFound: true },
      );
      const saved = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.equity_alert')
            .set({
              acknowledged_by: s.accountId,
              acknowledged_at: new Date(),
              action_taken: request.body.actionTaken,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          alertView(current as AlertRow),
        );
        await request.audit(trx, {
          action: 'equity.act',
          targetType: 'equity_alert',
          targetId: row.id,
          targetVersion: row.version,
          changes: { actionTaken: request.body.actionTaken },
        });
        const name = await trx
          .selectFrom('cg.account')
          .select('display_name')
          .where('id', '=', s.accountId)
          .executeTakeFirst();
        return { ...row, acknowledged_name: name?.display_name ?? null };
      });
      return alertView(saved as AlertRow);
    },
  );
};
