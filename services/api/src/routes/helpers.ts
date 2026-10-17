/**
 * Shared pieces for route modules: schemas, the data-dictionary classifier
 * for audit diffs, and the outbox writer (ADR-0007).
 */
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { dictionary, type Database } from '@cg/db';
import type { Classifier } from '@cg/audit';
import { PARTNER_CATEGORY_KEYS } from '@cg/reporting';
import { errors } from '../errors.ts';

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
/** AC-08A: how far ahead of the server's clock a device may date an entry (clock skew). */
export const AHEAD_ALLOWED_MS = 5 * 60_000;

/**
 * AC-08A: an entry made after the fact keeps when it happened (`occurredAt`)
 * beside when the server recorded it; it can be dated back, never ahead.
 * Returns the date to store, or undefined to let the database stamp now.
 */
export function occurredAtOf(value: string | undefined, now = Date.now()): Date | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  if (at.getTime() > now + AHEAD_ALLOWED_MS) {
    throw errors.validation([{ name: 'occurredAt', message: 'cannot be later than now' }]);
  }
  return at;
}

export function pickDefined<T extends Record<string, unknown>>(
  body: T,
  map: Partial<Record<keyof T & string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(map)) {
    const v = body[key];
    if (v !== undefined && column) out[column] = v;
  }
  return out;
}

/**
 * A stable UUID for one step of a client's request (an internal replay of a console route keyed
 * like the field commands, FR-00.06): the same client id and step always give the same key.
 */
export function stepKey(clientUuid: string, step: string): string {
  const h = createHash('sha256').update(`${clientUuid}:${step}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Partner counts on the declaration view and official reports (2026-10-15, DCL:DEC-09): roll
 * up all, or the chosen partner organizations and categories.
 */
export const partnerRollupIn = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    all: z.literal(false),
    partners: z.array(z.uuid()).max(500),
    categories: z.array(z.enum(PARTNER_CATEGORY_KEYS)).max(PARTNER_CATEGORY_KEYS.length),
  }),
]);

export const partnerRollupOut = z.object({
  all: z.boolean(),
  partners: z.array(z.uuid()).optional(),
  categories: z.array(z.string()).optional(),
});
