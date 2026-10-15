/**
 * Live translation in the field (layer-7 task H; FL-14, FL:FR-24, EQ-08,
 * AI-03, AI-10, AIG-01). One turn of a general conversation between a worker
 * and a survivor, translated by the tenant's provider, labelled as machine
 * translation on the phone. Consent, legal and medical conversations always
 * go to a human interpreter, so the server refuses them and says so; the
 * phone offers the interpreter request in one tap. Nothing said is kept: the
 * call's record holds the languages, outcome and model only.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { callAi, recordAiOutput } from '@cg/ai';
import { ApiError, errors } from '../errors.ts';
import type { DraftingDeps } from './drafting.ts';

export const translationRoutesWith =
  (deps: DraftingDeps = {}): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    app.post(
      '/translations',
      {
        schema: {
          tags: ['field'],
          body: z
            .object({
              text: z.string().trim().min(1).max(1000),
              from: z.enum(['en', 'es']),
              to: z.enum(['en', 'es']),
              topic: z.enum(['general', 'consent', 'legal', 'medical']).default('general'),
            })
            .refine((b) => b.from !== b.to, {
              message: 'choose two different languages',
              path: ['to'],
            }),
          response: {
            200: z.object({
              text: z.string(),
              from: z.string(),
              to: z.string(),
              provider: z.string(),
              model: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        const b = request.body;
        await request.authorize('translation.use', { type: 'translation', tenantId: s.tenantId });
        if (b.topic !== 'general')
          throw new ApiError(
            409,
            'human_interpreter',
            'Consent, legal and medical conversations always use a human interpreter (FL-14). Ask for one.',
          );
        const p = await request.tx(async (trx) => {
          const row = await trx
            .selectFrom('cg.ai_use_register')
            .select(['enabled', 'provider'])
            .where('tenant_id', '=', s.tenantId)
            .where('feature', '=', 'field.translation')
            .executeTakeFirst();
          if (!row?.enabled) return null;
          const provider = await deps.ai?.providerFor(s.tenantId, trx);
          return provider?.translation && provider.info.provider === row.provider ? provider : null;
        });
        if (!p)
          throw new ApiError(
            409,
            'ai_off',
            'Machine translation is off here. Ask for an interpreter.',
          );
        const call = await callAi(() => p.translation!.translate(b.text, b.to, b.from));
        await request.tx((trx) =>
          recordAiOutput(trx, {
            tenantId: s.tenantId,
            feature: 'field.translation',
            provider: call.ok ? call.out.provider : p.info,
            outcome: call.ok ? 'ok' : call.outcome,
            latencyMs: call.ok ? call.out.latencyMs : call.latencyMs,
            language: b.to,
          }),
        );
        if (!call.ok)
          throw new ApiError(
            503,
            'ai_unavailable',
            'The translation did not come back. Try again, or ask for an interpreter.',
            { retryable: true },
          );
        return {
          text: call.out.output.text,
          from: b.from,
          to: b.to,
          provider: call.out.provider.provider,
          model: call.out.provider.model,
        };
      },
    );
  };
