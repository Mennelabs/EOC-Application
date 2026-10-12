/**
 * Shared pieces for route modules: schemas, the data-dictionary classifier
 * for audit diffs, and the outbox writer (ADR-0007).
 */
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { dictionary, type Database } from '@cg/db';
import type { Classifier } from '@cg/audit';

export const uuidParam = z.object({ id: z.uuid() });

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const stamped = {
  id: z.uuid(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/** Audit-diff classifier from the data dictionary (SEC-11). Unknown columns count as internal. */
export function classifierFor(table: string): Classifier {
  const cols = dictionary[table] ?? {};
  return (field) => cols[field]?.c ?? 'internal';
}

export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

export async function enqueueOutbox(
  trx: Transaction<Database>,
  tenantId: string,
  topic: string,
  payload: Record<string, unknown>,
  executionId: string | null,
): Promise<void> {
  await trx
    .insertInto('cg.outbox')
    .values({
      tenant_id: tenantId,
      topic,
      payload: JSON.stringify(payload),
      execution_id: executionId,
    })
    .execute();
}

/** Narrow a PATCH body to the columns actually present, mapping camelCase → snake_case. */
export function pickDefined<T extends Record<string, unknown>>(
  body: T,
  map: Record<keyof T & string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(map)) {
    const v = body[key];
    if (v !== undefined) out[column] = v;
  }
  return out;
}
