/**
 * Voice notes on a field assessment (FLD-09, INT-13, INT-16, AIG-01/02/03/05,
 * AIG-10, AIG-12; layer-4 plan §14.2):
 *
 * The volunteer says what they see with the phone's own dictation (or types
 * it); this route asks the tenant's language model, through the AI use
 * register entry `field.voice_draft`, to draft the home type and the damage
 * seen. Each draft comes back as a plain statement with the words that
 * support it, for the volunteer to confirm or reject one by one; nothing
 * drafted is saved until confirmed (INT-13). The degree of damage is never
 * drafted: the volunteer picks it from pictures (FLD-08, "a human always
 * decides").
 *
 * It reuses the extraction the resident intake uses, over the tenant's
 * published intake graph, so the same evaluated provider and the same
 * output checks apply (AIG-03, AIG-08). The text is redacted first (AIG-05)
 * and passed as data (AIG-02). With the feature off, or no provider, the
 * answer is an honest "off" and the volunteer fills the fields in
 * themselves (INT-16, SCL-06). Every draft records provider and model.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import {
  callAi,
  extractionQuestions,
  recordAiOutput,
  redact,
  validateExtraction,
  type AiProvider,
} from '@cg/ai';
import type { Database } from '@cg/db';
import type { QuestionGraph } from '@cg/intake';
import { ApiError, errors } from '../errors.ts';
import { loadGraph, sha } from '../public/submit.ts';

export interface FieldVoiceDeps {
  ai?: { providerFor(tenantId: string, trx: Transaction<Database>): Promise<AiProvider | null> };
  defaultGraph?: QuestionGraph;
}

/** Intake answers → field assessment fields. The degree is deliberately absent (FLD-08). */
const HOME_TYPES: Record<string, string> = {
  house: 'single_family',
  mobile_manufactured: 'manufactured',
  apartment_condo: 'apartment_building',
  business: 'commercial',
};
export const SEEN = [
  'roof',
  'windows_doors',
  'walls',
  'tree_on_home',
  'moved_off_foundation',
] as const;

const draftOut = z.object({
  field: z.enum(['structure', 'water_inside', 'seen']),
  value: z.string(),
  /** The volunteer's words that support it, shown back with the draft (INT-13). */
  evidence: z.string(),
  confidence: z.number(),
});

export const fieldVoiceRoutes =
  (deps: FieldVoiceDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/field-assessments/draft',
      {
        schema: {
          tags: ['field'],
          body: z.object({
            /** The phone's id for the assessment being written; the draft is filed under it. */
            clientUuid: z.uuid(),
            text: z.string().min(1).max(4_000),
            language: z.enum(['en', 'es']).optional(),
          }),
          response: {
            200: z.object({
              draftId: z.uuid(),
              drafts: z.array(draftOut),
              injectionSuspected: z.boolean(),
              provider: z.object({ provider: z.string(), model: z.string() }),
              notice: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const s = request.subject;
        if (s.kind !== 'account') throw errors.unauthorized();
        await request.authorize('assessment.record', {
          type: 'field_assessment',
          tenantId: s.tenantId,
        });
        const off = () =>
          new ApiError(
            409,
            'ai_off',
            'Help from a computer is switched off here. Fill in the fields yourself; your words stay in the note.',
          );
        if (!deps.ai || !deps.defaultGraph) throw off();
        const ai = deps.ai;
        const fallback = deps.defaultGraph;
        // The provider is called outside any transaction: a slow reply holds no connection.
        const setup = await request.tx(async (trx) => {
          const feature = await trx
            .selectFrom('cg.ai_use_register')
            .select(['enabled', 'provider'])
            .where('feature', '=', 'field.voice_draft')
            .executeTakeFirst();
          if (!feature?.enabled) throw off();
          const provider = await ai.providerFor(s.tenantId, trx);
          if (!provider?.llm || provider.info.provider !== feature.provider) throw off();
          const graph = await loadGraph(trx, fallback.key, undefined, fallback);
          return { provider, llm: provider.llm, graph };
        });
        const graph = setup.graph;
        const { text } = redact(request.body.text); // AIG-05
        const call = await callAi(() =>
          setup.llm.extract({
            text,
            ...(request.body.language ? { language: request.body.language } : {}),
            questions: extractionQuestions(graph).filter((q) =>
              ['home_type', 'damage_types'].includes(q.id),
            ),
          }),
        );
        if (!call.ok) {
          // AI-10: recorded; the volunteer fills the fields and the words stay in the note.
          await request.tx((trx) =>
            recordAiOutput(trx, {
              tenantId: s.tenantId,
              feature: 'field.voice_draft',
              provider: setup.provider.info,
              outcome: call.outcome,
              latencyMs: call.latencyMs,
              language: request.body.language ?? null,
              executionId: request.body.clientUuid,
            }),
          );
          throw new ApiError(
            409,
            'ai_unavailable',
            'Help from a computer is not available right now. Fill in the fields yourself; your words stay in the note.',
          );
        }
        return request.tx(async (trx) => {
          const out = call.out;
          const valid = validateExtraction(graph, out.output); // AIG-03
          const drafts: z.infer<typeof draftOut>[] = [];
          if (!valid.injectionSuspected)
            for (const c of valid.candidates) {
              if (c.value.kind !== 'value') continue;
              const v = c.value.value;
              if (c.questionId === 'home_type' && typeof v === 'string' && HOME_TYPES[v])
                drafts.push({
                  field: 'structure',
                  value: HOME_TYPES[v],
                  evidence: c.evidence,
                  confidence: c.confidence,
                });
              if (c.questionId === 'damage_types') {
                const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
                for (const item of list) {
                  if (item === 'water_inside')
                    drafts.push({
                      field: 'water_inside',
                      value: 'yes',
                      evidence: c.evidence,
                      confidence: c.confidence,
                    });
                  else if ((SEEN as readonly string[]).includes(item))
                    drafts.push({
                      field: 'seen',
                      value: item,
                      evidence: c.evidence,
                      confidence: c.confidence,
                    });
                }
              }
            }
          const row = await trx
            .insertInto('cg.extraction')
            .values({
              tenant_id: s.tenantId,
              execution_id: request.body.clientUuid,
              input_hash: sha([request.body.text]),
              provider: out.provider.provider,
              model: out.provider.model,
              output: JSON.stringify({
                feature: 'field.voice_draft',
                drafts,
                language: valid.language ?? null,
                injectionSuspected: valid.injectionSuspected,
              }),
              filtered_reasons: valid.dropped.map((d) => `${d.questionId}:${d.reason}`),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await recordAiOutput(trx, {
            tenantId: s.tenantId,
            feature: 'field.voice_draft',
            provider: out.provider,
            outcome: valid.dropped.length > 0 ? 'filtered' : 'ok',
            latencyMs: out.latencyMs,
            language: valid.language ?? request.body.language ?? null,
            executionId: request.body.clientUuid,
            targetType: 'extraction',
            targetId: row.id,
          });
          await request.audit(trx, {
            action: 'assessment.draft',
            targetType: 'extraction',
            targetId: row.id,
            changes: {
              fields: [
                { name: 'provider', to: `${out.provider.provider}/${out.provider.model}` },
                { name: 'drafts', to: drafts.length },
                { name: 'injection_suspected', to: valid.injectionSuspected },
                { name: 'latency_ms', to: out.latencyMs },
              ],
            },
          });
          return {
            draftId: row.id,
            drafts,
            injectionSuspected: valid.injectionSuspected,
            provider: { provider: out.provider.provider, model: out.provider.model },
            // AIG-10: said plainly beside the drafts.
            notice: 'A computer drafted these from your words. Check each one.',
          };
        });
      },
    );
  };
