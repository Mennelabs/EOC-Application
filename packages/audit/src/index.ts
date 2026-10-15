/**
 * Audit writer and verifier (ADR-0012, SEC-18). The database enforces
 * append-only storage and the per-tenant hash chain (migration 0006); this
 * package is the one place application code writes audit rows, always inside
 * the business transaction so a failed write leaves no orphan audit row and a
 * successful one always has its record.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { beforeCommit, type ActorKind, type Database } from '@cg/db';

export * from './changes.ts';

export interface AuditInput {
  tenantId: string;
  actorKind: ActorKind;
  actorAccountId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  targetVersion?: number | null;
  changes?: unknown;
  executionId?: string | null;
  requestId?: string | null;
  /** Restricted data categories read by this action (SEC-18). */
  classificationRead?: string[];
  reason?: string | null;
  /** When the actor says it happened; recorded_at is set by the database (AC-08A). */
  occurredAt?: Date;
}

/**
 * Records an audit row in the business transaction. Under `withTenant` the
 * row is written after the transaction's own work, just before it commits
 * (`beforeCommit`): the insert takes the tenant's chain lock until commit
 * (migration 0040), so writing it last means every transaction locks its
 * rows before the chain, and a transaction that locked a row first and then
 * audits never waits on one that audited first and then wants that row
 * (the deadlock in CI run 38698603482). Rows keep the order they were
 * recorded in; if the transaction fails, none is written.
 */
export async function recordAudit(trx: Transaction<Database>, input: AuditInput): Promise<void> {
  // Taken now, so a later change to `input` cannot change the record.
  const values = {
    tenant_id: input.tenantId,
    actor_kind: input.actorKind,
    actor_account_id: input.actorAccountId ?? null,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    target_version: input.targetVersion ?? null,
    changes: input.changes === undefined ? null : JSON.stringify(input.changes),
    execution_id: input.executionId ?? null,
    request_id: input.requestId ?? null,
    classification_read: input.classificationRead ?? [],
    reason: input.reason ?? null,
    ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
  };
  const write = async () => {
    await trx.insertInto('cg.audit_event').values(values).execute();
  };
  if (!beforeCommit(trx, write)) await write();
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
}

/** Re-walks the tenant's chain in the database (cg.audit_verify). */
export async function verifyChain(
  db: Kysely<Database> | Transaction<Database>,
  tenantId: string,
): Promise<ChainVerification> {
  const { rows } = await sql<{ ok: boolean; checked: string; first_bad_seq: string | null }>`
    select ok, checked, first_bad_seq from cg.audit_verify(${tenantId}::uuid)`.execute(db);
  const r = rows[0];
  if (!r) return { ok: false, checked: 0, firstBadSeq: null };
  return {
    ok: r.ok,
    checked: Number(r.checked),
    firstBadSeq: r.first_bad_seq === null ? null : Number(r.first_bad_seq),
  };
}

/** Latest hash and seq of a tenant's chain, for anchoring (ADR-0012). */
export async function chainHead(
  db: Kysely<Database> | Transaction<Database>,
  tenantId: string,
): Promise<{ seq: number; hash: Buffer } | null> {
  const row = await db
    .selectFrom('cg.audit_event')
    .select(['seq', 'hash'])
    .where('tenant_id', '=', tenantId)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { seq: Number(row.seq), hash: row.hash } : null;
}
