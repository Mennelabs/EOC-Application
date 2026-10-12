/**
 * Question graph versions per tenant (INT-01, INT-08, INT-17, CON-02):
 * list, read, draft a new version from JSON (validated against the schema
 * and the reading-level and tone rules, with the findings returned), and
 * publish (consequential). Submissions name the version they used, so
 * every version stays readable.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { lintGraph, parseGraph } from '@cg/intake';
import { ApiError, errors } from '../errors.ts';
import { iso, uuidParam } from './helpers.ts';

const metaOut = z.object({
  id: z.uuid(),
  key: z.string(),
  graphVersion: z.number().int(),
  status: z.enum(['draft', 'published', 'retired']),
  languages: z.array(z.string()),
  hazards: z.array(z.string()),
  changeReason: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  publishedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  createdBy: z.uuid().nullable(),
  questions: z.number().int(),
});

const keyParam = z.object({ key: z.string().min(1).max(60) });
const keyVersionParam = keyParam.extend({ version: z.coerce.number().int().positive() });

export const intakeGraphRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  const meta = (r: {
    id: string;
    key: string;
    graph_version: number;
    status: 'draft' | 'published' | 'retired';
    languages: string[];
    hazards: string[];
    change_reason: string | null;
    published_at: Date | null;
    published_by: string | null;
    created_at: Date;
    created_by: string | null;
    graph: unknown;
  }): z.infer<typeof metaOut> => ({
    id: r.id,
    key: r.key,
    graphVersion: r.graph_version,
    status: r.status,
    languages: r.languages,
    hazards: r.hazards,
    changeReason: r.change_reason,
    publishedAt: iso(r.published_at),
    publishedBy: r.published_by,
    createdAt: iso(r.created_at)!,
    createdBy: r.created_by,
    questions: Array.isArray((r.graph as { nodes?: unknown[] })?.nodes)
      ? (r.graph as { nodes: { kind: string }[] }).nodes.filter((n) => n.kind === 'question').length
      : 0,
  });

  app.get(
    '/intake-graphs',
    { schema: { tags: ['intake graphs'], response: { 200: z.array(metaOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('intake_graph.read', { type: 'intake_graph', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.intake_graph')
          .selectAll()
          .orderBy('key')
          .orderBy('graph_version', 'desc')
          .execute(),
      );
      return rows.map(meta);
    },
  );

  app.get(
    '/intake-graphs/:key/:version',
    {
      schema: {
        tags: ['intake graphs'],
        params: keyVersionParam,
        response: { 200: metaOut.extend({ graph: z.unknown() }) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('intake_graph.read', { type: 'intake_graph', tenantId: s.tenantId });
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.intake_graph')
          .selectAll()
          .where('key', '=', request.params.key)
          .where('graph_version', '=', request.params.version)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      return { ...meta(row), graph: row.graph };
    },
  );

  /** A new draft version from JSON; the graph must pass the schema and the string rules (INT-08/17). */
  app.put(
    '/intake-graphs/:key',
    {
      config: { idempotent: true },
      schema: {
        tags: ['intake graphs'],
        params: keyParam,
        body: z.object({ graph: z.unknown(), changeReason: z.string().min(3).max(500) }),
        response: { 201: metaOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('intake_graph.edit', { type: 'intake_graph', tenantId: s.tenantId });
      let graph;
      try {
        graph = parseGraph(request.body.graph);
      } catch (err) {
        throw new ApiError(
          400,
          'validation_failed',
          'The question graph does not fit the schema.',
          {
            fields: [
              {
                name: 'graph',
                message: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
              },
            ],
          },
        );
      }
      if (graph.key !== request.params.key)
        throw new ApiError(400, 'validation_failed', 'The graph key must match the address.', {
          fields: [{ name: 'graph.key', message: `expected ${request.params.key}` }],
        });
      const findings = lintGraph(graph);
      if (findings.length > 0)
        throw new ApiError(
          400,
          'string_rules',
          'Some strings break the reading-level or tone rules.',
          {
            fields: findings.slice(0, 50).map((f) => ({
              name: `${f.nodeId}.${f.field} (${f.locale})`,
              message: `${f.rule}: ${f.detail}`,
            })),
          },
        );
      const row = await request.tx(async (trx) => {
        const latest = await trx
          .selectFrom('cg.intake_graph')
          .select((eb) => eb.fn.max('graph_version').as('v'))
          .where('key', '=', graph.key)
          .executeTakeFirst();
        const version = Number(latest?.v ?? 0) + 1;
        const inserted = await trx
          .insertInto('cg.intake_graph')
          .values({
            tenant_id: s.tenantId,
            key: graph.key,
            graph_version: version,
            status: 'draft',
            graph: JSON.stringify({ ...graph, version }),
            hazards: [...new Set(graph.nodes.flatMap((n) => n.hazards ?? []))],
            languages: graph.languages,
            change_reason: request.body.changeReason,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'intake_graph.edit',
          targetType: 'intake_graph',
          targetId: inserted.id,
          targetVersion: inserted.graph_version,
          changes: {
            fields: [
              { name: 'graph_version', to: version },
              { name: 'change_reason', to: request.body.changeReason },
            ],
          },
        });
        return inserted;
      });
      return reply.code(201).send(meta(row));
    },
  );

  app.post(
    '/intake-graphs/:key/:version/publish',
    { schema: { tags: ['intake graphs'], params: keyVersionParam, response: { 200: metaOut } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('intake_graph.publish', {
        type: 'intake_graph',
        tenantId: s.tenantId,
      });
      const { reason } = request.confirmation();
      const row = await request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.intake_graph')
          .selectAll()
          .where('key', '=', request.params.key)
          .where('graph_version', '=', request.params.version)
          .executeTakeFirst();
        if (!current) throw errors.notFound();
        if (current.status === 'published') return current;
        const updated = await trx
          .updateTable('cg.intake_graph')
          .set({
            status: 'published',
            published_at: new Date(),
            published_by: s.accountId,
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'intake_graph.publish',
          targetType: 'intake_graph',
          targetId: updated.id,
          targetVersion: updated.graph_version,
          reason,
          changes: { fields: [{ name: 'status', from: current.status, to: 'published' }] },
        });
        return updated;
      });
      return meta(row);
    },
  );

  void uuidParam;
};
