/**
 * AI drafting from computed facts, shared by the screens that offer it
 * (layer-7 task G; CMD-16, DCL:DEC-14, PUB-11, PUB-12, PUB-14, AI-04, AI-09,
 * AI-10, AIG-01, AIG-07). The register decides whether a feature may run and
 * on which provider; the provider is called outside any transaction; the
 * draft must pass the fact check (`checkDraft`) and the output filter before
 * anyone sees it; every call is recorded whatever its outcome. With the
 * feature off, or a refused draft, the rules' own draft stays: nothing that
 * works without AI stops working.
 */
import type { FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import {
  callAi,
  checkDraft,
  filterGeneratedText,
  recordAiOutput,
  type AiProvider,
  type DraftRequest,
  type DraftSentence,
  type ProviderInfo,
} from '@cg/ai';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';

export interface DraftingDeps {
  ai?: { providerFor(tenantId: string, trx: Transaction<Database>): Promise<AiProvider | null> };
}

export type DraftFeature = 'report.drafting' | 'declaration.drafting' | 'public.drafting';

export interface AiDraft {
  text: string;
  sentences: DraftSentence[];
  provider: ProviderInfo;
  outputId: string;
}

/**
 * Drafts with the feature's provider, or throws a 409 (off) or 422 (refused,
 * with the reasons) that the screen shows while keeping the rules' draft.
 */
export async function aiDraft(
  request: FastifyRequest,
  deps: DraftingDeps,
  feature: DraftFeature,
  req: DraftRequest,
  target: { type: string; id: string },
): Promise<AiDraft> {
  const s = request.subject;
  if (s.kind !== 'account') throw errors.unauthorized();
  const prep = await request.tx(async (trx) => {
    const row = await trx
      .selectFrom('cg.ai_use_register')
      .select(['enabled', 'provider'])
      .where('tenant_id', '=', s.tenantId)
      .where('feature', '=', feature)
      .executeTakeFirst();
    if (!row?.enabled) return null;
    const provider = await deps.ai?.providerFor(s.tenantId, trx);
    return provider?.llm?.draft && provider.info.provider === row.provider ? provider : null;
  });
  if (!prep)
    throw new ApiError(
      409,
      'ai_off',
      'The AI drafting assistant is off here. The draft from the rules stays, and you can edit it.',
    );
  const call = await callAi(() => prep.llm!.draft!(req));
  const check = call.ok ? checkDraft(call.out.output, req) : null;
  const filter = check?.ok ? filterGeneratedText(check.text) : null;
  const outcome = !call.ok
    ? call.outcome
    : !check!.ok
      ? 'invalid'
      : !filter!.allowed
        ? 'filtered'
        : 'ok';
  const outputId = await request.tx((trx) =>
    recordAiOutput(trx, {
      tenantId: s.tenantId,
      feature,
      provider: call.ok ? call.out.provider : prep.info,
      outcome,
      latencyMs: call.ok ? call.out.latencyMs : call.latencyMs,
      language: req.language,
      targetType: target.type,
      targetId: target.id,
    }),
  );
  if (!call.ok)
    throw new ApiError(
      503,
      'ai_unavailable',
      'The AI drafting assistant did not answer. The draft from the rules stays.',
      { retryable: true },
    );
  if (!check!.ok || !filter!.allowed)
    throw new ApiError(
      422,
      'ai_draft_refused',
      'The AI draft was refused and is not shown: it did not keep to the facts. The draft from the rules stays.',
      { details: { problems: [...check!.problems, ...(filter?.reasons ?? [])] } },
    );
  return {
    text: check!.text,
    sentences: call.out.output.sentences.filter((x) => x.text.trim()),
    provider: call.out.provider,
    outputId,
  };
}
