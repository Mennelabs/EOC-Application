/**
 * Resident reference codes (INT-22, FL-01): four letters and four digits with
 * no ambiguous characters (no I, L, O, 0, 1), e.g. KXMR-4827. Codes are
 * pre-generated into cg.reference_code and leased to this API instance in
 * batches, so the submission hot path does not wait on the database
 * (architecture §7). The worker binds code → report when it files the
 * submission and keeps the pool topped up; the code rules live in @cg/db.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { generateCodes, withTenant, type Database } from '@cg/db';

export {
  CODE_DIGITS,
  CODE_LETTERS,
  CODE_PATTERN,
  generateCodes,
  normaliseCode,
  randomCode,
} from '@cg/db';

export class ReferenceCodeLeaser {
  private readonly pools = new Map<string, string[]>();
  private readonly db: Kysely<Database>;
  private readonly instance: string;
  private readonly batch: number;

  constructor(db: Kysely<Database>, instance: string, batch = 50) {
    this.db = db;
    this.instance = instance;
    this.batch = batch;
  }

  /** One code for a submission; refills the in-memory pool from the database when empty. */
  async lease(tenantId: string): Promise<string> {
    const pool = this.pools.get(tenantId) ?? [];
    if (pool.length === 0) {
      const leased = await withTenant(this.db, { tenantId }, async (trx) => {
        let rows = await this.leaseBatch(trx, tenantId);
        if (rows.length < this.batch) {
          await generateCodes(trx, tenantId, this.batch * 2);
          rows = rows.concat(await this.leaseBatch(trx, tenantId));
        }
        return rows;
      });
      pool.push(...leased);
      this.pools.set(tenantId, pool);
    }
    const code = pool.shift();
    if (!code) throw new Error('reference code pool exhausted');
    return code;
  }

  private async leaseBatch(trx: Transaction<Database>, tenantId: string): Promise<string[]> {
    const res = await sql<{ code: string }>`
      update cg.reference_code set state = 'leased', leased_by = ${this.instance}, leased_at = now()
      where (tenant_id, code) in (
        select tenant_id, code from cg.reference_code
        where tenant_id = ${tenantId} and state = 'free'
        limit ${this.batch} for update skip locked)
      returning code`.execute(trx);
    return res.rows.map((r) => r.code);
  }
}
