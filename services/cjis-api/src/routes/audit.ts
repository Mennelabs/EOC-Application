/**
 * Enclave audit review and retention (SEC-18, BRD:FR-08.04, SEC-13; CJIS
 * audit review weekly, retention per CJIS and state records rules). Security
 * officers and auditors read, filter, verify and export the agency's own
 * chain and record the weekly review; security officers set retention and
 * place or release legal holds. Reading the audit is itself audited.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { CjisDatabase } from '@cg/cjis-db';
import { errors, ApiError } from '../errors.ts';

const auditQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  action: z.string().max(80).optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  actor: z.uuid().optional(),
  target: z.string().max(80).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Formula-looking cells are prefixed so a spreadsheet does not run them.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const auditRoutes: FastifyPluginAsync = async (appBase) => {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  async function verify(trx: Transaction<CjisDatabase>, agencyId: string) {
    const { rows } = await sql<{ ok: boolean; checked: string; first_bad_seq: string | null }>`
      select ok, checked, first_bad_seq from cjis.audit_verify(${agencyId}::uuid)`.execute(trx);
    const r = rows[0];
    return {
      ok: r?.ok ?? false,
      checked: Number(r?.checked ?? 0),
      firstBadSeq: r?.first_bad_seq ? Number(r.first_bad_seq) : null,
    };
  }

  app.get('/audit', { schema: { querystring: auditQuery } }, async (request) => {
    const s = request.person();
    await request.authorize('audit.read', { type: 'audit_event', agencyId: s.agencyId });
    const q = request.query;
    return request.tx(async (trx) => {
      let query = trx
        .selectFrom('cjis.audit_event as a')
        .leftJoin('cjis.person as p', 'p.id', 'a.actor_person_id')
        .select([
          'a.seq',
          'a.occurred_at',
          'a.recorded_at',
          'a.actor_kind',
          'a.actor_person_id',
          'p.display_name as actor',
          'a.action',
          'a.target_type',
          'a.target_id',
          'a.target_version',
          'a.outcome',
          'a.reason',
          'a.fields',
          'a.source_ip',
        ])
        .orderBy('a.seq', 'desc')
        .limit(q.limit);
      if (q.from) query = query.where('a.occurred_at', '>=', new Date(q.from));
      if (q.to) query = query.where('a.occurred_at', '<', new Date(q.to));
      if (q.action) query = query.where('a.action', 'like', `${q.action.replace(/[%_]/g, '')}%`);
      if (q.outcome) query = query.where('a.outcome', '=', q.outcome);
      if (q.actor) query = query.where('a.actor_person_id', '=', q.actor);
      if (q.target) query = query.where('a.target_id', '=', q.target);
      if (q.before) query = query.where('a.seq', '<', String(q.before));
      const rows = await query.execute();
      await request.audit(trx, {
        action: 'audit.read',
        targetType: 'audit_event',
        targetId: '*',
        reason: `${rows.length} rows`,
      });
      return rows.map((r) => ({
        seq: Number(r.seq),
        occurredAt: r.occurred_at.toISOString(),
        recordedAt: r.recorded_at.toISOString(),
        actorKind: r.actor_kind,
        actorPersonId: r.actor_person_id,
        actor: r.actor,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        targetVersion: r.target_version,
        outcome: r.outcome,
        reason: r.reason,
        fields: r.fields,
        sourceIp: r.source_ip,
      }));
    });
  });

  app.post('/audit/verify', async (request) => {
    const s = request.person();
    await request.authorize('audit.verify', { type: 'audit_event', agencyId: s.agencyId });
    return request.tx(async (trx) => {
      const v = await verify(trx, s.agencyId);
      await request.audit(trx, {
        action: 'audit.verify',
        targetType: 'audit_event',
        targetId: '*',
        outcome: v.ok ? 'success' : 'failure',
        reason: v.ok ? `${v.checked} rows verified` : `chain breaks at ${v.firstBadSeq}`,
      });
      return v;
    });
  });

  app.get(
    '/audit/export',
    {
      schema: {
        querystring: z.object({
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
        }),
      },
    },
    async (request, reply) => {
      const s = request.person();
      const d = await request.authorize('audit.export', {
        type: 'audit_event',
        agencyId: s.agencyId,
      });
      return request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cjis.audit_event')
          .select([
            'seq',
            'occurred_at',
            'recorded_at',
            'actor_kind',
            'actor_person_id',
            'action',
            'target_type',
            'target_id',
            'target_version',
            'outcome',
            'reason',
            'fields',
            'source_ip',
            'hash',
          ])
          .where('occurred_at', '>=', new Date(request.query.from))
          .where('occurred_at', '<', new Date(request.query.to))
          .orderBy('seq')
          .limit(50_000)
          .execute();
        await request.audit(trx, {
          action: 'audit.export',
          targetType: 'audit_event',
          targetId: '*',
          reason: `${rows.length} rows ${request.query.from} to ${request.query.to}: ${d.confirmedReason ?? ''}`,
        });
        const header = [
          'seq',
          'occurred_at',
          'recorded_at',
          'actor_kind',
          'actor_person_id',
          'action',
          'target_type',
          'target_id',
          'target_version',
          'outcome',
          'reason',
          'fields',
          'source_ip',
          'hash',
        ];
        const lines = [header.join(',')];
        for (const r of rows) {
          lines.push(
            [
              r.seq,
              r.occurred_at.toISOString(),
              r.recorded_at.toISOString(),
              r.actor_kind,
              r.actor_person_id,
              r.action,
              r.target_type,
              r.target_id,
              r.target_version,
              r.outcome,
              r.reason,
              r.fields.join(' '),
              r.source_ip,
              r.hash.toString('hex'),
            ]
              .map(csvCell)
              .join(','),
          );
        }
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="enclave-audit.csv"');
        return `${lines.join('\n')}\n`;
      });
    },
  );

  app.get('/audit/reviews', async (request) => {
    const s = request.person();
    await request.authorize('audit.read', { type: 'audit_event', agencyId: s.agencyId });
    return request.tx(async (trx) =>
      (
        await trx
          .selectFrom('cjis.audit_review as r')
          .innerJoin('cjis.person as p', 'p.id', 'r.reviewer_person_id')
          .select([
            'r.id',
            'r.period_from',
            'r.period_to',
            'r.checked',
            'r.chain_ok',
            'r.note',
            'r.created_at',
            'p.display_name as reviewer',
          ])
          .orderBy('r.created_at', 'desc')
          .limit(52)
          .execute()
      ).map((r) => ({
        id: r.id,
        periodFrom: new Date(r.period_from).toISOString(),
        periodTo: new Date(r.period_to).toISOString(),
        checked: r.checked,
        chainOk: r.chain_ok,
        note: r.note,
        reviewer: r.reviewer,
        createdAt: r.created_at.toISOString(),
      })),
    );
  });

  app.post(
    '/audit/reviews',
    {
      schema: {
        body: z.object({
          periodFrom: z.iso.datetime({ offset: true }),
          periodTo: z.iso.datetime({ offset: true }),
          note: z.string().trim().min(3).max(4000),
        }),
      },
      config: { idempotent: true },
    },
    async (request, reply) => {
      const s = request.person();
      await request.authorize('audit.review', { type: 'audit_review', agencyId: s.agencyId });
      const b = request.body;
      if (new Date(b.periodTo) <= new Date(b.periodFrom))
        throw errors.validation([{ name: 'periodTo', message: 'the period ends after it starts' }]);
      return request.tx(async (trx) => {
        const v = await verify(trx, s.agencyId);
        const row = await trx
          .insertInto('cjis.audit_review')
          .values({
            agency_id: s.agencyId,
            reviewer_person_id: s.personId,
            period_from: b.periodFrom,
            period_to: b.periodTo,
            checked: v.checked,
            chain_ok: v.ok,
            note: b.note,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'audit.review',
          targetType: 'audit_review',
          targetId: row.id,
          reason: `chain ${v.ok ? 'verified' : 'broken'} (${v.checked} rows)`,
        });
        return reply.code(201).send({ id: row.id, chainOk: v.ok, checked: v.checked });
      });
    },
  );

  // --- Retention and legal holds (SEC-13) ---

  app.get('/retention', async (request) => {
    const s = request.person();
    await request.authorize('retention.read', { type: 'retention_policy', agencyId: s.agencyId });
    return request.tx(async (trx) => {
      const policies = await trx
        .selectFrom('cjis.retention_policy')
        .select(['category', 'keep_days', 'basis', 'version', 'updated_at'])
        .orderBy('category')
        .execute();
      const holds = await trx
        .selectFrom('cjis.legal_hold as h')
        .leftJoin('cjis.record as r', 'r.id', 'h.record_id')
        .innerJoin('cjis.person as p', 'p.id', 'h.placed_by')
        .select([
          'h.id',
          'h.reason',
          'h.placed_at',
          'h.released_at',
          'h.release_reason',
          'h.version',
          'r.cji_ref',
          'r.platform_mission_reference',
          'p.display_name as placedBy',
        ])
        .orderBy('h.placed_at', 'desc')
        .limit(200)
        .execute();
      const deletions = await trx
        .selectFrom('cjis.deletion_log')
        .select(['category', 'cutoff', 'deleted', 'held', 'ran_at'])
        .orderBy('ran_at', 'desc')
        .limit(50)
        .execute();
      return {
        policies: policies.map((p) => ({
          category: p.category,
          keepDays: p.keep_days,
          basis: p.basis,
          version: p.version,
          updatedAt: p.updated_at.toISOString(),
        })),
        holds: holds.map((h) => ({
          id: h.id,
          ref: h.cji_ref,
          missionReference: h.platform_mission_reference,
          scope: h.cji_ref ? 'record' : 'agency',
          reason: h.reason,
          placedBy: h.placedBy,
          placedAt: h.placed_at.toISOString(),
          releasedAt: h.released_at?.toISOString() ?? null,
          releaseReason: h.release_reason,
          version: h.version,
        })),
        deletions: deletions.map((d) => ({
          category: d.category,
          cutoff: d.cutoff.toISOString(),
          deleted: d.deleted,
          held: d.held,
          ranAt: d.ran_at.toISOString(),
        })),
      };
    });
  });

  app.put(
    '/retention/:category',
    {
      schema: {
        params: z.object({ category: z.enum(['records', 'audit']) }),
        body: z.object({
          keepDays: z.number().int().positive().max(36_500),
          basis: z.string().trim().min(3).max(300),
        }),
      },
      config: { requiresVersion: true },
    },
    async (request) => {
      const s = request.person();
      const d = await request.authorize('retention.write', {
        type: 'retention_policy',
        id: request.params.category,
        agencyId: s.agencyId,
      });
      const floor = request.params.category === 'audit' ? 2557 : 365;
      if (request.body.keepDays < floor)
        throw errors.validation([
          {
            name: 'keepDays',
            message:
              request.params.category === 'audit'
                ? 'audit is kept at least seven years'
                : 'records are kept at least one year',
          },
        ]);
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cjis.retention_policy')
          .set({
            keep_days: request.body.keepDays,
            basis: request.body.basis,
            updated_by: s.personId,
          })
          .where('category', '=', request.params.category)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw errors.conflict(null);
        await request.audit(trx, {
          action: 'retention.write',
          targetType: 'retention_policy',
          targetId: request.params.category,
          targetVersion: updated.version,
          reason: `${request.body.keepDays} days: ${d.confirmedReason ?? ''}`,
        });
        return {
          category: updated.category,
          keepDays: updated.keep_days,
          basis: updated.basis,
          version: updated.version,
        };
      });
    },
  );

  app.post(
    '/holds',
    {
      schema: {
        body: z.object({
          ref: z
            .string()
            .regex(/^[A-Za-z0-9_-]{32,64}$/)
            .optional(),
          reason: z.string().trim().min(3).max(500),
        }),
      },
      config: { idempotent: true },
    },
    async (request, reply) => {
      const s = request.person();
      const d = await request.authorize('hold.place', { type: 'legal_hold', agencyId: s.agencyId });
      return request.tx(async (trx) => {
        let recordId: string | null = null;
        if (request.body.ref) {
          const r = await trx
            .selectFrom('cjis.record')
            .select('id')
            .where('cji_ref', '=', request.body.ref)
            .executeTakeFirst();
          if (!r) throw errors.validation([{ name: 'ref', message: 'no such record here' }]);
          recordId = r.id;
        }
        const row = await trx
          .insertInto('cjis.legal_hold')
          .values({
            agency_id: s.agencyId,
            record_id: recordId,
            reason: request.body.reason,
            placed_by: s.personId,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'hold.place',
          targetType: 'legal_hold',
          targetId: row.id,
          reason: `${request.body.ref ? 'record' : 'agency'}: ${d.confirmedReason ?? ''}`,
        });
        return reply.code(201).send({ id: row.id, version: row.version });
      });
    },
  );

  app.post(
    '/holds/:id/release',
    { schema: { params: z.object({ id: z.uuid() }) }, config: { requiresVersion: true } },
    async (request) => {
      const s = request.person();
      const d = await request.authorize('hold.release', {
        type: 'legal_hold',
        id: request.params.id,
        agencyId: s.agencyId,
      });
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cjis.legal_hold')
          .set({
            released_at: new Date(),
            released_by: s.personId,
            release_reason: d.confirmedReason,
          })
          .where('id', '=', request.params.id)
          .where('released_at', 'is', null)
          .where('version', '=', expected)
          .returning(['id', 'version'])
          .executeTakeFirst();
        if (!updated) throw new ApiError(409, 'hold_changed', 'The hold changed or was released.');
        await request.audit(trx, {
          action: 'hold.release',
          targetType: 'legal_hold',
          targetId: updated.id,
          reason: d.confirmedReason,
        });
        return { id: updated.id, version: updated.version };
      });
    },
  );
};
