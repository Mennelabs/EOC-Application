/**
 * Resident dictation (INT-12, AIG-06, AIG-05, AIG-10, AI-10; layer 7). The
 * resident records a few seconds of speech on the "your own words" step; the
 * recording comes here, goes to the tenant's provider's speech-to-text (OpenAI
 * under zero data retention, ADR-0043) only where the AI use register has
 * `intake.transcription` on, and the words come back into the text box for
 * the resident to read and change. Nothing of it is stored: neither the
 * recording nor the words (they are kept only if the resident sends the
 * report). The call is recorded with its outcome and language, never its
 * content. This replaces the browser's own speech recognition, which in
 * Chrome streams the audio to Google and in Safari to Apple, outside the
 * platform's provider terms.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import { callAi, recordAiOutput, type AiProvider } from '@cg/ai';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { WindowCounter } from './abuse.ts';

export const DICTATION_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
] as const;
/** About two minutes of speech in the browsers' compressed formats. */
export const MAX_DICTATION_BYTES = 4 * 1024 * 1024;
/** Recordings per address per 10 minutes before refusing (SEC-17). */
const PER_ADDRESS = 30;

export interface DictationDeps {
  ai?: { providerFor(tenantId: string, trx: Transaction<Database>): Promise<AiProvider | null> };
}

/** Whether the tenant's register and provider allow dictation now (shown before the button). */
export async function dictationOn(
  deps: DictationDeps,
  trx: Transaction<Database>,
  tenantId: string,
): Promise<boolean> {
  if (!deps.ai) return false;
  const feature = await trx
    .selectFrom('cg.ai_use_register')
    .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
    .select(['enabled', 'provider'])
    .where('feature', '=', 'intake.transcription')
    .executeTakeFirst();
  if (!feature?.enabled) return false;
  const provider = await deps.ai.providerFor(tenantId, trx);
  return Boolean(provider?.stt && provider.info.provider === feature.provider);
}

export const dictationRoutes =
  (deps: DictationDeps): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();
    const perAddress = new WindowCounter(10 * 60_000);

    const tenantOf = (request: FastifyRequest) => {
      const t = (request as FastifyRequest & { publicTenant?: { id: string } }).publicTenant;
      if (!t) throw errors.notFound();
      return t;
    };

    app.addContentTypeParser(
      [...DICTATION_TYPES],
      { parseAs: 'buffer', bodyLimit: MAX_DICTATION_BYTES + 1024 },
      (_req, body, done) => done(null, body),
    );

    app.post(
      '/intake/:tenant/dictation',
      {
        bodyLimit: MAX_DICTATION_BYTES + 1024,
        schema: {
          tags: ['public intake'],
          params: z.object({ tenant: z.string().min(2).max(60) }),
          querystring: z.object({
            executionId: z.uuid(),
            language: z.string().min(2).max(10).optional(),
          }),
          response: { 200: z.object({ text: z.string(), language: z.string() }) },
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        await request.authorize('intake.transcribe', { type: 'dictation', tenantId: tenant.id });
        if (request.ip && perAddress.hit(`${tenant.id}:${request.ip}`) > PER_ADDRESS)
          throw new ApiError(429, 'too_many_requests', 'Please wait a little and try again.', {
            retryable: true,
          });
        const audio = request.body;
        if (!Buffer.isBuffer(audio) || audio.length === 0)
          throw new ApiError(400, 'validation_failed', 'Send the recording as the request body.');
        const mime = String(request.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim();
        // AI-10: without the feature the resident types; the step works the same.
        const off = () =>
          new ApiError(
            409,
            'ai_off',
            'Speaking instead of typing is not available here. Please type your words.',
          );
        if (!deps.ai) throw off();
        // The provider is called outside any transaction: a slow reply holds no connection.
        const setup = await request.tx(async (trx) => {
          if (!(await dictationOn(deps, trx, tenant.id))) throw off();
          const provider = (await deps.ai!.providerFor(tenant.id, trx))!;
          return { provider, stt: provider.stt! };
        });
        const language = request.query.language;
        const call = await callAi(() => setup.stt.transcribe(audio, mime, language));
        await request.tx((trx) =>
          recordAiOutput(trx, {
            tenantId: tenant.id,
            feature: 'intake.transcription',
            provider: call.ok ? call.out.provider : setup.provider.info,
            outcome: call.ok ? 'ok' : call.outcome,
            latencyMs: call.ok ? call.out.latencyMs : call.latencyMs,
            language: call.ok ? call.out.output.language : (language ?? null),
            executionId: request.query.executionId,
          }),
        );
        if (!call.ok)
          throw new ApiError(
            409,
            'ai_unavailable',
            'We could not write down what you said. Please try again, or type your words.',
          );
        return { text: call.out.output.text.trim(), language: call.out.output.language };
      },
    );
  };
