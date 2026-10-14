/**
 * The enclave audit writer (SEC-18, BRD:FR-08.04, ADR-0037). The database
 * enforces the chain and immutability (migration 0004); this is the one
 * place enclave code writes audit rows, inside the business transaction, so
 * a failed write leaves no audit row and a successful one always has its row.
 * Only field names are recorded, never a value (no CJI in the audit).
 */
import type { Transaction } from 'kysely';
import type { AuditActorKind, AuditOutcome, CjisDatabase } from '@cg/cjis-db';

export interface EnclaveAuditInput {
  agencyId: string | null;
  actorKind: AuditActorKind;
  actorPersonId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  targetVersion?: number | null;
  outcome: AuditOutcome;
  reason?: string | null;
  fields?: string[];
  requestId?: string | null;
  sourceIp?: string | null;
  occurredAt?: Date;
}

export async function recordEnclaveAudit(
  trx: Transaction<CjisDatabase>,
  input: EnclaveAuditInput,
): Promise<void> {
  await trx
    .insertInto('cjis.audit_event')
    .values({
      agency_id: input.agencyId,
      actor_kind: input.actorKind,
      actor_person_id: input.actorPersonId ?? null,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId,
      target_version: input.targetVersion ?? null,
      outcome: input.outcome,
      reason: input.reason ? input.reason.slice(0, 500) : null,
      fields: input.fields ?? [],
      request_id: input.requestId ?? null,
      source_ip: input.sourceIp ?? null,
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
    })
    .execute();
}
