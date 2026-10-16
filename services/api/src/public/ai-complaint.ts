/**
 * AIG-09: a resident says the computer help they were given went wrong. The
 * help is named by the report's own execution id and the feature (the answers
 * read from their words, or the words written down from their voice); the
 * complaint is one of a few fixed reasons, with no words, kept on that help's
 * AI output for the health job to count. The answer is the same whether or
 * not there was such help, so nothing can be learned by trying ids.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errors } from '../errors.ts';
import { WindowCounter } from './abuse.ts';

export const COMPLAINT_FEATURES = ['intake.extraction', 'intake.transcription'] as const;
export const COMPLAINT_REASONS = [
  'wrong',
  'not_my_language',
  'hard_to_understand',
  'other',
] as const;
/** Complaints per address per 10 minutes before refusing (SEC-17). */
const PER_ADDRESS = 20;

export const aiComplaintRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const perAddress = new WindowCounter(10 * 60_000);
  const tenantOf = (request: FastifyRequest) => {
    const t = (request as FastifyRequest & { publicTenant?: { id: string } }).publicTenant;
    if (!t) throw errors.notFound();
    return t;
  };

  app.post(
    '/intake/:tenant/ai-complaint',
    {
      schema: {
        tags: ['public intake'],
        params: z.object({ tenant: z.string().min(2).max(60) }),
        body: z.object({
          executionId: z.uuid(),
          feature: z.enum(COMPLAINT_FEATURES),
          reason: z.enum(COMPLAINT_REASONS),
        }),
        response: { 202: z.object({ received: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      await request.authorize('intake.ai_complaint', { type: 'ai_output', tenantId: tenant.id });
      if (request.ip && perAddress.hit(`${tenant.id}:${request.ip}`) > PER_ADDRESS)
        throw new ApiError(429, 'too_many_requests', 'Please wait a little and try again.', {
          retryable: true,
        });
      const b = request.body;
      // The latest help of that kind for this report, once; a second complaint changes nothing.
      await request.tx((trx) =>
        trx
          .updateTable('cg.ai_output')
          .set({ complaint: b.reason, complained_at: new Date() })
          .where(
            'id',
            '=',
            trx
              .selectFrom('cg.ai_output')
              .select('id')
              .where('execution_id', '=', b.executionId)
              .where('feature', '=', b.feature)
              .orderBy('created_at', 'desc')
              .limit(1),
          )
          .where('complaint', 'is', null)
          .execute(),
      );
      return reply.code(202).send({ received: true as const });
    },
  );
};
