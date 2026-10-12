/**
 * After-saving answers (INT-19, EQ-13): aggregate answers in clear for
 * counts, restricted ones encrypted. One row per report; a later batch
 * replaces an earlier one (the resident may answer again).
 */
import type { Transaction } from 'kysely';
import type { Database } from './schema.ts';

export interface AfterAnswersInput {
  tenantId: string;
  reportId: string;
  answers: Record<string, unknown>;
  isRestricted: (questionId: string) => boolean;
  encrypt: (text: string) => Promise<Buffer>;
}

export async function upsertAfterAnswers(
  trx: Transaction<Database>,
  input: AfterAnswersInput,
): Promise<void> {
  const clear: Record<string, unknown> = {};
  const restricted: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(input.answers)) {
    if (input.isRestricted(id)) restricted[id] = value;
    else clear[id] = value;
  }
  const existing = await trx
    .selectFrom('cg.post_submission_answers')
    .select(['id'])
    .where('report_id', '=', input.reportId)
    .executeTakeFirst();
  const values = {
    aggregate_answers: JSON.stringify(clear),
    restricted_answers_enc:
      Object.keys(restricted).length > 0 ? await input.encrypt(JSON.stringify(restricted)) : null,
  };
  if (existing)
    await trx
      .updateTable('cg.post_submission_answers')
      .set(values)
      .where('id', '=', existing.id)
      .execute();
  else
    await trx
      .insertInto('cg.post_submission_answers')
      .values({ tenant_id: input.tenantId, report_id: input.reportId, ...values })
      .execute();
}
