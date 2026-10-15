/**
 * Metrics (layer-6 task G; BRD:FR-14.01–14.07, AC-14A/B/C, MET-04/05/06/10):
 * one computation per scope (event, bounded period in the county's time
 * zone, filters) answers the screen, the CSV and the PDF, so the three
 * carry the same totals and name the same definitions, generation time and
 * exclusions. Exports are audited with their scope. No metric carries a
 * personal field.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { renderPdf } from '@cg/pdf';
import {
  DEGREES,
  MAX_PERIOD_DAYS,
  computeMetrics,
  metricsCsv,
  metricsPdf,
  type MetricScope,
} from '@cg/reporting';
import { errors } from '../errors.ts';
import { uuidParam } from './helpers.ts';

const query = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  missionKind: z.string().max(40).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  missionState: z
    .enum(['draft', 'open', 'en_route', 'on_scene', 'cleared', 'closed', 'canceled'])
    .optional(),
  department: z.uuid().optional(),
  degree: z.enum(DEGREES).optional(),
});

const DAY = 86_400_000;

export const metricRoutes =
  (opts: { productName?: string } = {}): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    /** The scope asked for, bounded (FR-14.02): by default the last seven days of the event. */
    const compute = async (request: FastifyRequest, eventId: string, q: z.infer<typeof query>) =>
      request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event as e')
          .innerJoin('cg.tenant as t', 't.id', 'e.tenant_id')
          .select([
            'e.id',
            'e.name',
            'e.tenant_id',
            'e.opened_at',
            't.timezone',
            't.name as county',
          ])
          .where('e.id', '=', eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        const to = q.to ? new Date(q.to) : new Date();
        const opened = event.opened_at
          ? new Date(event.opened_at).getTime()
          : to.getTime() - 7 * DAY;
        const from = q.from ? new Date(q.from) : new Date(Math.max(opened, to.getTime() - 7 * DAY));
        if (from.getTime() >= to.getTime())
          throw errors.validation([
            { name: 'from', message: 'the period must start before it ends' },
          ]);
        if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY)
          throw errors.validation([
            { name: 'from', message: `a period covers at most ${MAX_PERIOD_DAYS} days` },
          ]);
        const scope: MetricScope = {
          eventId,
          from,
          to,
          timeZone: event.timezone,
          filters: {
            ...(q.missionKind ? { missionKind: q.missionKind } : {}),
            ...(q.priority ? { priority: q.priority } : {}),
            ...(q.missionState ? { missionState: q.missionState } : {}),
            ...(q.department ? { department: q.department } : {}),
            ...(q.degree ? { degree: q.degree } : {}),
          },
        };
        const result = await computeMetrics(trx, event.tenant_id, scope);
        return { result, event };
      });

    app.get(
      '/events/:id/metrics',
      { schema: { tags: ['metrics'], params: uuidParam, querystring: query } },
      async (request) => {
        const s = account(request);
        await request.authorize('metric.read', {
          type: 'metric',
          tenantId: s.tenantId,
          eventId: request.params.id,
        });
        return (await compute(request, request.params.id, request.query)).result;
      },
    );

    for (const format of ['csv', 'pdf'] as const)
      app.get(
        `/events/:id/metrics.${format}`,
        { schema: { tags: ['metrics'], params: uuidParam, querystring: query } },
        async (request, reply) => {
          const s = account(request);
          await request.authorize('metric.export', {
            type: 'metric',
            tenantId: s.tenantId,
            eventId: request.params.id,
          });
          const { result, event } = await compute(request, request.params.id, request.query);
          await request.tx((trx) =>
            request.audit(trx, {
              action: 'metric.export',
              targetType: 'event',
              targetId: event.id,
              changes: { format, scope: result.scope, generatedAt: result.generatedAt },
            }),
          );
          const name = `metrics-${result.scope.from.slice(0, 10)}-to-${result.scope.to.slice(0, 10)}.${format}`;
          reply.header('content-disposition', `attachment; filename="${name}"`);
          if (format === 'csv')
            return reply.header('content-type', 'text/csv; charset=utf-8').send(metricsCsv(result));
          const pdf = await renderPdf(
            metricsPdf(result, {
              productName: opts.productName ?? 'the platform',
              eventName: event.name,
              countyName: event.county,
            }),
          );
          return reply.header('content-type', 'application/pdf').send(pdf);
        },
      );
  };
