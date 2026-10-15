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
import type { S3Client } from '@aws-sdk/client-s3';
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
  type SpeechRequest,
} from '@cg/ai';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';

export interface DraftingDeps {
  ai?: { providerFor(tenantId: string, trx: Transaction<Database>): Promise<AiProvider | null> };
  /** Where AI-voiced audio files are kept (PUB-14). */
  objects?: { client: Pick<S3Client, 'send'>; bucket: string };
}

export type DraftFeature = 'report.drafting' | 'declaration.drafting' | 'public.drafting';

type Prepared = NonNullable<Awaited<ReturnType<NonNullable<DraftingDeps['ai']>['providerFor']>>>;

/** The feature's provider when the register has it on and the provider can do it; else null. */
async function providerIf(
  request: FastifyRequest,
  deps: DraftingDeps,
  tenantId: string,
  feature: string,
  can: (p: Prepared) => boolean,
): Promise<Prepared | null> {
  return request.tx(async (trx) => {
    const row = await trx
      .selectFrom('cg.ai_use_register')
      .select(['enabled', 'provider'])
      .where('tenant_id', '=', tenantId)
      .where('feature', '=', feature)
      .executeTakeFirst();
    if (!row?.enabled) return null;
    const provider = await deps.ai?.providerFor(tenantId, trx);
    return provider && can(provider) && provider.info.provider === row.provider ? provider : null;
  });
}

export interface AiDraft {
  text: string;
  sentences: DraftSentence[];
  provider: ProviderInfo;
  outputId: string;
}

/**
 * Drafts with the feature's provider, or throws a 409 (off) or 422 (refused,
 * with the reasons) that the screen shows while keeping the rules' draft.
 * `publicContacts` are the county's own published numbers a public text may
 * carry (its help line); anyone else's is still filtered out (AIG-07).
 */
export async function aiDraft(
  request: FastifyRequest,
  deps: DraftingDeps,
  feature: DraftFeature,
  req: DraftRequest,
  target: { type: string; id: string },
  opts: { publicContacts?: string[] } = {},
): Promise<AiDraft> {
  const s = request.subject;
  if (s.kind !== 'account') throw errors.unauthorized();
  const prep = await providerIf(request, deps, s.tenantId, feature, (p) => Boolean(p.llm?.draft));
  if (!prep)
    throw new ApiError(
      409,
      'ai_off',
      'The AI drafting assistant is off here. The draft from the rules stays, and you can edit it.',
    );
  const call = await callAi(() => prep.llm!.draft!(req));
  const check = call.ok ? checkDraft(call.out.output, req) : null;
  const filter = check?.ok ? filterGeneratedText(check.text, opts) : null;
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

export interface AiSpeech {
  audio: Buffer;
  mimeType: string;
  provider: ProviderInfo;
  outputId: string;
}

/**
 * PUB-14: speaks a script a person approved with the AI voice (feature
 * `public.speech`), outside any transaction, recorded whatever the outcome
 * (AIG-01). Off gives a 409 and the script stays for a person to read on
 * the air.
 */
export async function aiSpeak(
  request: FastifyRequest,
  deps: DraftingDeps,
  req: SpeechRequest,
  target: { type: string; id: string },
): Promise<AiSpeech> {
  const s = request.subject;
  if (s.kind !== 'account') throw errors.unauthorized();
  const prep = await providerIf(request, deps, s.tenantId, 'public.speech', (p) => Boolean(p.tts));
  if (!prep)
    throw new ApiError(
      409,
      'ai_off',
      'The AI voice is off here. The script stays for a person to read on the air.',
    );
  const call = await callAi(() => prep.tts!.speak(req));
  const outputId = await request.tx((trx) =>
    recordAiOutput(trx, {
      tenantId: s.tenantId,
      feature: 'public.speech',
      provider: call.ok ? call.out.provider : prep.info,
      outcome: call.ok ? 'ok' : call.outcome,
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
      'The AI voice did not answer. The script stays for a person to read on the air.',
      { retryable: true },
    );
  return {
    audio: call.out.output.audio,
    mimeType: call.out.output.mimeType,
    provider: call.out.provider,
    outputId,
  };
}
