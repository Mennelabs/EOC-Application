/**
 * Resident re-entry passes (FL:FR-03: law enforcement at perimeters "scan
 * resident re-entry passes and approved contractor and volunteer credentials
 * at checkpoints; log entries. No criminal-justice data (SEC-12)"). The EOC
 * issues a pass for a household to go back into a closed zone of an event for
 * a window of time: the zone, how many people, who it is for and which home.
 * The name and address are encrypted and read only by roles that issue or
 * check passes; every read of them is audited. The code is shown once to
 * print and kept only as a hash. A pass can be revoked with a reason. The
 * checkpoint scans it through the badge check (routes/field-ops.ts), which
 * logs each scan here with its place and result; the log names no one.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errors } from '../errors.ts';
import { hashCode, newBadgeCode } from './field-ops.ts';
import { iso, uuidParam } from './helpers.ts';

const passOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  eventId: z.uuid(),
  zone: z.string(),
  holderName: z.string().nullable(),
  address: z.string().nullable(),
  people: z.number().int(),
  validFrom: z.string(),
  validTo: z.string(),
  state: z.enum(['active', 'revoked', 'expired']),
  reportId: z.uuid().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
  checks: z.number().int(),
  lastCheck: z
    .object({ at: z.string(), checkpoint: z.string().nullable(), result: z.string() })
    .nullable(),
});

export const reentryRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const read = async (tenantId: string, enc: Buffer) => {
    try {
      return await app.fieldCrypto.decrypt(tenantId, enc);
    } catch {
      return null;
    }
  };

  app.post(
    '/reentry-passes',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          eventId: z.uuid(),
          zone: z.string().trim().min(1).max(120),
          holderName: z.string().trim().min(1).max(200),
          address: z.string().trim().min(3).max(300),
          people: z.number().int().min(1).max(20).default(1),
          /** How long the pass is good for, from now. */
          validHours: z
            .number()
            .int()
            .min(1)
            .max(14 * 24)
            .default(72),
          /** The household's damage report, when there is one, showing the home. */
          reportId: z.uuid().optional(),
        }),
        response: {
          201: z.object({
            id: z.uuid(),
            /** Shown once: print it now; only its hash is kept. */
            code: z.string(),
            zone: z.string(),
            people: z.number().int(),
            validFrom: z.string(),
            validTo: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('reentry_pass.issue', {
        type: 'reentry_pass',
        tenantId: s.tenantId,
        eventId: b.eventId,
      });
      const { reason } = request.confirmation();
      const code = newBadgeCode();
      const validFrom = new Date();
      const validTo = new Date(validFrom.getTime() + b.validHours * 3_600_000);
      const row = await request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select(['id', 'status'])
          .where('id', '=', b.eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        if (event.status !== 'active')
          throw new ApiError(409, 'event_not_active', 'Passes are issued only for an open event.');
        if (b.reportId) {
          const report = await trx
            .selectFrom('cg.report')
            .select('id')
            .where('id', '=', b.reportId)
            .where('event_id', '=', b.eventId)
            .executeTakeFirst();
          if (!report)
            throw errors.validation([
              { name: 'reportId', message: 'no such report in this event' },
            ]);
        }
        const inserted = await trx
          .insertInto('cg.reentry_pass')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            code_hash: hashCode(s.tenantId, code),
            zone: b.zone,
            holder_name_enc: await app.fieldCrypto.encrypt(s.tenantId, b.holderName),
            address_enc: await app.fieldCrypto.encrypt(s.tenantId, b.address),
            people: b.people,
            valid_from: validFrom,
            valid_to: validTo,
            report_id: b.reportId ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'reentry_pass.issue',
          targetType: 'reentry_pass',
          targetId: inserted.id,
          targetVersion: inserted.version,
          reason: reason ?? null,
          changes: {
            fields: [
              { name: 'zone', to: b.zone },
              { name: 'people', to: b.people },
              { name: 'valid_to', to: validTo.toISOString() },
            ],
          },
        });
        return inserted;
      });
      reply.code(201);
      return {
        id: row.id,
        code,
        zone: b.zone,
        people: b.people,
        validFrom: validFrom.toISOString(),
        validTo: validTo.toISOString(),
      };
    },
  );

  app.get(
    '/reentry-passes',
    {
      schema: {
        tags: ['field'],
        querystring: z.object({ eventId: z.uuid() }),
        response: { 200: z.array(passOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const { eventId } = request.query;
      await request.authorize('reentry_pass.read', {
        type: 'reentry_pass',
        tenantId: s.tenantId,
        eventId,
      });
      return request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cg.reentry_pass')
          .selectAll()
          .where('event_id', '=', eventId)
          .orderBy('created_at', 'desc')
          .limit(500)
          .execute();
        const ids = rows.map((r) => r.id);
        const checks = ids.length
          ? await trx
              .selectFrom('cg.reentry_check')
              .select(['pass_id', 'checkpoint', 'result', 'checked_at'])
              .where('pass_id', 'in', ids)
              .orderBy('checked_at', 'desc')
              .execute()
          : [];
        // Reading the holders and homes is a read of restricted data: audited.
        await request.audit(trx, {
          action: 'reentry_pass.read',
          targetType: 'event',
          targetId: eventId,
          changes: { fields: [{ name: 'passes', to: rows.length }] },
        });
        const now = Date.now();
        const out = [];
        for (const r of rows) {
          const mine = checks.filter((c) => c.pass_id === r.id);
          out.push({
            id: r.id,
            version: r.version,
            eventId: r.event_id,
            zone: r.zone,
            holderName: await read(r.tenant_id, r.holder_name_enc),
            address: await read(r.tenant_id, r.address_enc),
            people: r.people,
            validFrom: iso(r.valid_from)!,
            validTo: iso(r.valid_to)!,
            state:
              r.state === 'revoked'
                ? ('revoked' as const)
                : new Date(r.valid_to).getTime() < now
                  ? ('expired' as const)
                  : ('active' as const),
            reportId: r.report_id,
            revokedAt: iso(r.revoked_at),
            revokeReason: r.revoke_reason,
            checks: mine.length,
            lastCheck: mine[0]
              ? {
                  at: iso(mine[0].checked_at)!,
                  checkpoint: mine[0].checkpoint,
                  result: mine[0].result,
                }
              : null,
          });
        }
        return out;
      });
    },
  );

  app.post(
    '/reentry-passes/:id/revoke',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        response: { 200: z.object({ id: z.uuid(), state: z.literal('revoked') }) },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.reentry_pass')
          .select(['id', 'tenant_id', 'event_id', 'state', 'version'])
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'reentry_pass.revoke',
        {
          type: 'reentry_pass',
          id: current.id,
          tenantId: current.tenant_id,
          eventId: current.event_id,
        },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      if (current.state === 'revoked')
        throw new ApiError(409, 'already_revoked', 'This pass is already revoked.');
      await request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cg.reentry_pass')
          .set({
            state: 'revoked',
            revoked_at: new Date(),
            revoked_by: s.accountId,
            revoke_reason: reason ?? null,
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returning('version')
          .executeTakeFirst();
        if (!updated)
          throw new ApiError(409, 'version_conflict', 'The pass changed; reload and try again.');
        await request.audit(trx, {
          action: 'reentry_pass.revoke',
          targetType: 'reentry_pass',
          targetId: current.id,
          targetVersion: updated.version,
          reason: reason ?? null,
          changes: { fields: [{ name: 'state', from: current.state, to: 'revoked' }] },
        });
      });
      return { id: current.id, state: 'revoked' as const };
    },
  );

  /** FL:FR-03: the log of entries at the perimeter: where, when and the result; no one named. */
  app.get(
    '/reentry-passes/checks',
    {
      schema: {
        tags: ['field'],
        querystring: z.object({ eventId: z.uuid() }),
        response: {
          200: z.array(
            z.object({
              passId: z.uuid(),
              zone: z.string(),
              checkpoint: z.string().nullable(),
              result: z.string(),
              at: z.string(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const s = account(request);
      const { eventId } = request.query;
      await request.authorize('reentry_pass.read', {
        type: 'reentry_pass',
        tenantId: s.tenantId,
        eventId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.reentry_check as c')
          .innerJoin('cg.reentry_pass as p', 'p.id', 'c.pass_id')
          .select(['c.pass_id', 'p.zone', 'c.checkpoint', 'c.result', 'c.checked_at'])
          .where('c.event_id', '=', eventId)
          .orderBy('c.checked_at', 'desc')
          .limit(500)
          .execute(),
      );
      return rows.map((r) => ({
        passId: r.pass_id,
        zone: r.zone,
        checkpoint: r.checkpoint,
        result: r.result,
        at: iso(r.checked_at)!,
      }));
    },
  );
};
