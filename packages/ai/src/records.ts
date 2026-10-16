/**
 * AI output records (layer-7 task A; AIG-01, AI-03, AI-10, CMD-37, NFR-10).
 *
 * `callAi` runs one provider call and turns any failure into an outcome, so a
 * caller cannot forget the manual path (AI-10). `recordAiOutput` writes the
 * call's record: feature, provider, the model that answered, template
 * version, language, latency and outcome, never the prompt or the reply.
 * `recordHumanAction` says what a person did with an output; the health job
 * reads those to alert administrators (AIG-09 as decided 2026-10-15).
 */
import type { Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { AiProviderError } from './providers/openai.ts';
import type { AiOutput, ProviderInfo } from './types.ts';

export type AiOutcome = 'ok' | 'filtered' | 'invalid' | 'refused' | 'timeout' | 'error';
export type HumanAction = 'accepted' | 'edited' | 'rejected';

export type AiCall<T> =
  | { ok: true; out: AiOutput<T> }
  | { ok: false; outcome: Exclude<AiOutcome, 'ok' | 'filtered'>; latencyMs: number };

/** One provider call; a failure, a refusal, a timeout or a bad reply is an outcome, not a throw. */
export async function callAi<T>(
  fn: () => Promise<AiOutput<T>>,
  now: () => number = Date.now,
): Promise<AiCall<T>> {
  const started = now();
  try {
    return { ok: true, out: await fn() };
  } catch (err) {
    const latencyMs = Math.max(0, now() - started);
    if (err instanceof AiProviderError) {
      const outcome =
        err.kind === 'timeout'
          ? 'timeout'
          : err.kind === 'refused'
            ? 'refused'
            : err.kind === 'http'
              ? 'error'
              : 'invalid';
      return { ok: false, outcome, latencyMs };
    }
    return { ok: false, outcome: 'error', latencyMs };
  }
}

export interface AiOutputRecord {
  tenantId: string;
  feature: string;
  provider: ProviderInfo;
  outcome: AiOutcome;
  latencyMs: number;
  language?: string | null;
  executionId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
}

/** NFR-10: a service counts AI calls by feature and outcome (never their content). */
let outcomeObserver: ((feature: string, outcome: AiOutcome) => void) | null = null;
export function observeAiOutcomes(
  fn: ((feature: string, outcome: AiOutcome) => void) | null,
): void {
  outcomeObserver = fn;
}

/** The record of one AI call (AIG-01). Returns its id. */
export async function recordAiOutput(
  trx: Transaction<Database>,
  r: AiOutputRecord,
): Promise<string> {
  outcomeObserver?.(r.feature, r.outcome);
  const row = await trx
    .insertInto('cg.ai_output')
    .values({
      tenant_id: r.tenantId,
      feature: r.feature,
      provider: r.provider.provider,
      model: r.provider.model,
      template_version: r.provider.templateVersion ?? null,
      language: r.language ?? null,
      outcome: r.outcome,
      latency_ms: Math.round(r.latencyMs),
      execution_id: r.executionId ?? null,
      target_type: r.targetType ?? null,
      target_id: r.targetId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** What a person did with the output about a record; the first decision stands. */
export async function recordHumanAction(
  trx: Transaction<Database>,
  target: { type: string; id: string },
  action: HumanAction,
  actedBy: string | null,
  at: Date = new Date(),
): Promise<number> {
  const res = await trx
    .updateTable('cg.ai_output')
    .set({ human_action: action, acted_by: actedBy, acted_at: at })
    .where('target_type', '=', target.type)
    .where('target_id', '=', target.id)
    .where('human_action', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}
