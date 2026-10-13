/**
 * Abuse protection without CAPTCHAs (SEC-17, BRD:FR-11.05, ACC-44): per-IP
 * token buckets in this process, per-contact counts from the database, and a
 * risk score. Decisions:
 *   allow  → nothing changes;
 *   verify → the submission is still accepted (rule 8: never fail a
 *            submission); the report carries a "contact not verified" signal
 *            for reviewers and the resident can verify through the lookup;
 *   deny   → only for floods from one address (429, retryable).
 * Every non-allow decision is recorded in cg.abuse_signal, audited.
 */
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database } from '@cg/db';

export interface RiskInput {
  ip: string | undefined;
  /** Blind index of the phone or email, when given. */
  contactBidx: Buffer | null;
  /** Hash of the answers, to catch the same content submitted again and again. */
  contentHash: Buffer;
  hasContact: boolean;
}

export type RiskDecision = 'allow' | 'verify' | 'deny';

export interface RiskResult {
  decision: RiskDecision;
  score: number;
  reasons: string[];
}

export interface AbuseLimits {
  /** Submissions per IP per 10 minutes before verify / deny. */
  ipVerify: number;
  ipDeny: number;
  /** Submissions per contact per day before verify. */
  contactVerify: number;
  /** Identical content per tenant per hour before verify. */
  duplicateVerify: number;
}

export const DEFAULT_LIMITS: AbuseLimits = {
  ipVerify: 20,
  ipDeny: 120,
  contactVerify: 4,
  duplicateVerify: 3,
};

export function hashSubject(kind: 'ip' | 'content', value: string | Buffer): Buffer {
  return createHash('sha256').update(kind).update(':').update(value).digest();
}

/** Sliding window counter per key, in memory (per API instance). */
export class WindowCounter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }
  hit(key: string, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.hits.clear(); // bounded memory under a flood
    return list.length;
  }
}

export class RiskScorer {
  private readonly ipCounter = new WindowCounter(10 * 60_000);
  private readonly limits: AbuseLimits;
  constructor(limits: AbuseLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  async score(trx: Transaction<Database>, tenantId: string, input: RiskInput): Promise<RiskResult> {
    const reasons: string[] = [];
    let score = 0;
    if (input.ip) {
      const n = this.ipCounter.hit(`${tenantId}:${input.ip}`);
      if (n > this.limits.ipDeny) {
        reasons.push('ip_flood');
        score += 100;
      } else if (n > this.limits.ipVerify) {
        reasons.push('ip_burst');
        score += 40;
      }
    }
    const dayAgo = new Date(Date.now() - 24 * 3_600_000);
    if (input.contactBidx) {
      const r = await trx
        .selectFrom('cg.party')
        .innerJoin('cg.report', 'cg.report.reporter_party_id', 'cg.party.id')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('cg.party.tenant_id', '=', tenantId)
        .where((eb) =>
          eb.or([
            eb('cg.party.phone_bidx', '=', input.contactBidx!),
            eb('cg.party.email_bidx', '=', input.contactBidx!),
          ]),
        )
        .where('cg.report.submitted_at', '>', dayAgo)
        .executeTakeFirst();
      if (Number(r?.n ?? 0) >= this.limits.contactVerify) {
        reasons.push('contact_repeat');
        score += 40;
      }
    }
    const hourAgo = new Date(Date.now() - 3_600_000);
    const dup = await trx
      .selectFrom('cg.abuse_signal')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId)
      .where('kind', '=', 'content')
      .where('subject_hash', '=', hashSubject('content', input.contentHash))
      .where('created_at', '>', hourAgo)
      .executeTakeFirst();
    if (Number(dup?.n ?? 0) >= this.limits.duplicateVerify) {
      reasons.push('duplicate_content');
      score += 40;
    }
    if (!input.hasContact) score += 10; // nothing to verify against; reviewers see it
    const decision: RiskDecision = score >= 100 ? 'deny' : score >= 40 ? 'verify' : 'allow';
    return { decision, score, reasons };
  }

  /** Records what was seen so later requests can be scored; never blocks the caller on failure. */
  async record(
    trx: Transaction<Database>,
    tenantId: string,
    executionId: string,
    input: RiskInput,
    result: RiskResult,
  ): Promise<void> {
    const rows: { kind: string; subject_hash: Buffer }[] = [
      { kind: 'content', subject_hash: hashSubject('content', input.contentHash) },
    ];
    if (input.ip) rows.push({ kind: 'ip', subject_hash: hashSubject('ip', input.ip) });
    await trx
      .insertInto('cg.abuse_signal')
      .values(
        rows.map((r) => ({
          tenant_id: tenantId,
          kind: r.kind,
          subject_hash: r.subject_hash,
          execution_id: executionId,
          score: result.score,
          decision: result.decision,
          details: JSON.stringify({ reasons: result.reasons }),
        })),
      )
      .execute();
  }
}
