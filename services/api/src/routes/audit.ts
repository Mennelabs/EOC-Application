/**
 * Audit log reader, verifier and export (SEC-18, BRD:FR-08.05, RULE-07).
 * Reading the audit log is itself audited; exports are consequential and
 * carry the chain hash of each row so a reviewer can check them later.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { chainHead, verifyChain } from '@cg/audit';
import { errors } from '../errors.ts';
import { iso } from './helpers.ts';

const auditQuery = z.object({
  targetType: z.string().max(60).optional(),
  targetId: z.string().max(200).optional(),
  actorAccountId: z.uuid().optional(),
  action: z.string().max(80).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Page backwards from this sequence number (exclusive). */
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const auditRow = z.object({
  seq: z.number().int(),
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  actorAccountId: z.uuid().nullable(),
  actorKind: z.enum(['account', 'break_glass', 'public', 'system']),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  targetVersion: z.number().int().nullable(),
  changes: z.unknown().nullable(),
  executionId: z.uuid().nullable(),
  requestId: z.string().nullable(),
  classificationRead: z.array(z.string()),
  reason: z.string().nullable(),
  hash: z.string(),
  prevHash: z.string().nullable(),
});

type Row = {
  seq: number | string;
  occurred_at: Date;
  recorded_at: Date;
  actor_account_id: string | null;
  actor_kind: 'account' | 'break_glass' | 'public' | 'system';
  action: string;
  target_type: string;
  target_id: string;
  target_version: number | null;
  changes: unknown;
  execution_id: string | null;
  request_id: string | null;
  classification_read: string[];
  reason: string | null;
  hash: Buffer;
  prev_hash: Buffer | null;
};

const toRow = (r: Row): z.infer<typeof auditRow> => ({
  seq: Number(r.seq),
  occurredAt: iso(r.occurred_at)!,
  recordedAt: iso(r.recorded_at)!,
  actorAccountId: r.actor_account_id,
  actorKind: r.actor_kind,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  targetVersion: r.target_version,
  changes: r.changes,
  executionId: r.execution_id,
  requestId: r.request_id,
  classificationRead: r.classification_read,
  reason: r.reason,
  hash: r.hash.toString('hex'),
  prevHash: r.prev_hash ? r.prev_hash.toString('hex') : null,
});

export const auditRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  async function query(
    request: FastifyRequest,
    q: z.infer<typeof auditQuery>,
    action: 'audit.read' | 'audit.export',
    limit: number,
  ) {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    await request.authorize(action, { type: 'audit_event', tenantId: s.tenantId });
    return request.tx(async (trx) => {
      let sel = trx.selectFrom('cg.audit_event').selectAll().orderBy('seq', 'desc').limit(limit);
      if (q.targetType) sel = sel.where('target_type', '=', q.targetType);
      if (q.targetId) sel = sel.where('target_id', '=', q.targetId);
      if (q.actorAccountId) sel = sel.where('actor_account_id', '=', q.actorAccountId);
      if (q.action) sel = sel.where('action', '=', q.action);
      if (q.from) sel = sel.where('occurred_at', '>=', new Date(q.from));
      if (q.to) sel = sel.where('occurred_at', '<=', new Date(q.to));
      if (q.beforeSeq) sel = sel.where('seq', '<', q.beforeSeq);
      const rows = await sel.execute();
      await request.audit(trx, {
        action,
        targetType: 'audit_event',
        targetId: `filter:${JSON.stringify({ ...q, limit: undefined })}`,
        classificationRead: ['audit'],
        reason: `${rows.length} rows`,
      });
      return rows.map(toRow);
    });
  }

  app.get(
    '/audit',
    { schema: { tags: ['audit'], querystring: auditQuery, response: { 200: z.array(auditRow) } } },
    (request) => query(request, request.query, 'audit.read', request.query.limit),
  );

  app.get(
    '/audit/verify',
    {
      schema: {
        tags: ['audit'],
        response: {
          200: z.object({
            ok: z.boolean(),
            checked: z.number().int(),
            firstBadSeq: z.number().int().nullable(),
            head: z.object({ seq: z.number().int(), hash: z.string() }).nullable(),
            lastAnchor: z
              .object({
                throughSeq: z.number().int(),
                anchoredAt: z.iso.datetime(),
                objectKey: z.string().nullable(),
              })
              .nullable(),
          }),
        },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('audit.verify', { type: 'audit_event', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const result = await verifyChain(trx, s.tenantId);
        const head = await chainHead(trx, s.tenantId);
        const anchor = await trx
          .selectFrom('cg.audit_anchor')
          .select(['through_seq', 'anchored_at', 'object_key'])
          .orderBy('through_seq', 'desc')
          .executeTakeFirst();
        return {
          ...result,
          head: head ? { seq: head.seq, hash: head.hash.toString('hex') } : null,
          lastAnchor: anchor
            ? {
                throughSeq: Number(anchor.through_seq),
                anchoredAt: iso(anchor.anchored_at)!,
                objectKey: anchor.object_key,
              }
            : null,
        };
      });
    },
  );

  // Export: consequential (needs confirmation + reason), larger page, same redaction as the log itself.
  app.get(
    '/audit/export',
    { schema: { tags: ['audit'], querystring: auditQuery, response: { 200: z.array(auditRow) } } },
    (request) =>
      query(request, request.query, 'audit.export', Math.max(request.query.limit, 500) * 20),
  );
};
