/**
 * Resident reference codes (INT-22, FL-01): four letters and four digits with
 * no ambiguous characters (no I, L, O, 0, 1), e.g. KXMR-4827. The API leases
 * codes from the pool; the worker binds them to reports and keeps the pool
 * topped up. The space holds 1.1 billion codes, so leased codes are never
 * recycled: a code shown to a resident is never shown to anyone else.
 */
import { randomInt } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database } from './schema.ts';

export const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_DIGITS = '23456789';
export const CODE_PATTERN = /^[A-HJKMNP-Z]{4}-[2-9]{4}$/;

export function randomCode(): string {
  let letters = '';
  for (let i = 0; i < 4; i++) letters += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  let digits = '';
  for (let i = 0; i < 4; i++) digits += CODE_DIGITS[randomInt(CODE_DIGITS.length)];
  return `${letters}-${digits}`;
}

/** Accepts what people type: lower case, missing hyphen, spaces, 0/O and 1/I confusions. */
export function normaliseCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return null;
  const letters = raw.slice(0, 4).replace(/0/g, 'O').replace(/1/g, 'I');
  const digits = raw.slice(4).replace(/O/g, '0').replace(/I|L/g, '1');
  const code = `${letters}-${digits}`;
  return CODE_PATTERN.test(code) ? code : null;
}

/** Inserts `count` fresh free codes for a tenant (collisions are skipped and retried). */
export async function generateCodes(
  trx: Transaction<Database>,
  tenantId: string,
  count: number,
): Promise<number> {
  let inserted = 0;
  for (let attempt = 0; attempt < 5 && inserted < count; attempt++) {
    const codes = Array.from({ length: count - inserted }, randomCode);
    const res = await trx
      .insertInto('cg.reference_code')
      .values(codes.map((code) => ({ tenant_id: tenantId, code })))
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    inserted += Number(res.numInsertedOrUpdatedRows ?? 0);
  }
  return inserted;
}

/** Free (unleased) codes a tenant still has in its pool. */
export async function countFreeCodes(
  trx: Transaction<Database>,
  tenantId: string,
): Promise<number> {
  const row = await trx
    .selectFrom('cg.reference_code')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('state', '=', 'free')
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}
