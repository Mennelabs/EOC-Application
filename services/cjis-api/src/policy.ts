/**
 * The enclave's own policy (SEC-12, ADM-05, ADR-0036). Pure functions, no
 * database: the request plugin builds the subject fresh on every request and
 * asks `decide`. Order of evaluation:
 *   E1 unknown action                               → deny (default deny)
 *   E2 not CJIS-qualified (every action but me.read) → deny
 *   E3 another agency's record                      → deny, unless the owner
 *      shares it with the subject's agency now and the action only reads
 *   E4 audit records are never changed              → deny
 *   E5 a second administrator decides; nobody decides
 *      a request they made or one about themselves,
 *      and nobody administers their own account      → deny
 *   E6 nobody reviews their own disposition          → deny
 *   role holds the action                            → allow
 *   otherwise                                        → deny
 * Roles are fixed per enclave role (no county editing): criminal-justice
 * access is not configurable away (ADM-05). There is no break-glass.
 */
import type { EnclaveRole, FingerprintStatus, PersonStatus } from '@cg/cjis-db';

export interface EnclaveAction {
  kind: 'read' | 'write' | 'admin' | 'export';
  roles: readonly EnclaveRole[];
  description: string;
  /** RULE-14: needs X-Confirm and a reason. */
  consequential?: boolean;
  /** Allowed before qualification is complete (to see what is missing). */
  unqualified?: boolean;
}

const RECORD_WORKERS = ['officer', 'supervisor', 'records_clerk'] as const;
const ADMINS = ['agency_admin', 'security_officer'] as const;
const AUDIT = ['security_officer', 'auditor'] as const;

const act = (
  kind: EnclaveAction['kind'],
  roles: readonly EnclaveRole[],
  description: string,
  extra: Partial<EnclaveAction> = {},
): EnclaveAction => ({ kind, roles, description, ...extra });

export const ENCLAVE_ACTIONS = {
  'me.read': act('read', [], 'Own enclave account, roles and qualification', {
    unqualified: true,
  }),
  'record.read': act('read', RECORD_WORKERS, 'Read a law-enforcement record and its entries'),
  'record.list': act('read', RECORD_WORKERS, 'List the agency’s law-enforcement records'),
  'record.create': act('write', RECORD_WORKERS, 'Create the enclave record for a mission'),
  'record.update': act('write', RECORD_WORKERS, 'Change a record’s classification and summary'),
  'record.entry.write': act(
    'write',
    RECORD_WORKERS,
    'Add, change or remove people involved, weapons and body-camera references',
  ),
  'record.narrative': act('write', RECORD_WORKERS, 'Add a narrative or an amendment'),
  'record.disposition': act(
    'write',
    ['officer', 'supervisor'],
    'Record the law-enforcement disposition and close the record',
    { consequential: true },
  ),
  'record.review': act('write', ['supervisor'], 'Review a disposition', { consequential: true }),
  'record.reopen': act('write', ['supervisor'], 'Reopen a closed record', { consequential: true }),
  // Mutual aid (decision 2026-10-15): the owner's supervisor or administrator grants a helping
  // agency a read of one record for a set period; the grant and its end are consequential.
  'record.share': act(
    'write',
    ['supervisor', 'agency_admin'],
    'Share a record with another agency for a set period',
    {
      consequential: true,
    },
  ),
  'record.share.revoke': act(
    'write',
    ['supervisor', 'agency_admin'],
    'End a share before its time',
    {
      consequential: true,
    },
  ),
  'record.share.read': act(
    'read',
    [...RECORD_WORKERS, ...ADMINS],
    'See which agencies a record is shared with, and the agencies to share with',
  ),
  'account.read': act('read', ADMINS, 'List and read enclave accounts'),
  'account.create': act('admin', ['agency_admin'], 'Create an enclave account'),
  'account.screening': act(
    'admin',
    ['agency_admin'],
    'Record fingerprint-check and training dates',
  ),
  'account.activate': act('admin', ADMINS, 'Create the identity and the one-time password', {
    consequential: true,
  }),
  'account.suspend': act('admin', ADMINS, 'Suspend an enclave account', { consequential: true }),
  'account.reactivate': act('admin', ADMINS, 'Reactivate a suspended account', {
    consequential: true,
  }),
  'account.deactivate': act('admin', ['agency_admin'], 'Deactivate an enclave account', {
    consequential: true,
  }),
  'permission.read': act('read', ADMINS, 'Read role requests'),
  'permission.request': act('admin', ADMINS, 'Ask for a role to be granted or revoked'),
  'permission.decide': act('admin', ADMINS, 'Approve or reject a role request', {
    consequential: true,
  }),
  'audit.read': act('read', AUDIT, 'Read the enclave audit'),
  'audit.verify': act('read', AUDIT, 'Verify the enclave audit chain'),
  'audit.export': act('export', AUDIT, 'Export the enclave audit', { consequential: true }),
  'audit.review': act('write', AUDIT, 'Record the weekly audit review'),
  'retention.read': act('read', AUDIT, 'Read retention periods, holds and deletions'),
  'retention.write': act('admin', ['security_officer'], 'Change a retention period', {
    consequential: true,
  }),
  'hold.place': act('admin', ['security_officer'], 'Place a legal hold', {
    consequential: true,
  }),
  'hold.release': act('admin', ['security_officer'], 'Release a legal hold', {
    consequential: true,
  }),
} as const satisfies Record<string, EnclaveAction>;

export type EnclaveActionKey = keyof typeof ENCLAVE_ACTIONS;

/** Actions nobody may take on their own account or permissions (E5, ADM-05). */
export const SELF_FORBIDDEN: readonly string[] = [
  'permission.decide',
  'account.screening',
  'account.activate',
  'account.suspend',
  'account.reactivate',
  'account.deactivate',
];

export function isEnclaveAction(key: string): key is EnclaveActionKey {
  return Object.prototype.hasOwnProperty.call(ENCLAVE_ACTIONS, key);
}

export type Missing =
  'account_not_active' | 'agency_not_active' | 'fingerprint_check' | 'security_training' | 'role';

export interface QualificationFacts {
  status: PersonStatus;
  agencyStatus: 'active' | 'suspended';
  fingerprintStatus: FingerprintStatus;
  fingerprintAdjudicatedOn: Date | null;
  trainingExpiresOn: Date | null;
  roles: readonly EnclaveRole[];
}

/**
 * "CJIS-qualified" (layer-5 plan §4): an active account in an active agency,
 * an adjudicated fingerprint-based check before access (PS-3), training that
 * has not lapsed (AT-2), and at least one approved role. The day training
 * expires it no longer counts.
 */
export function qualification(
  f: QualificationFacts,
  today: Date = new Date(),
): { qualified: boolean; missing: Missing[] } {
  const missing: Missing[] = [];
  if (f.status !== 'active') missing.push('account_not_active');
  if (f.agencyStatus !== 'active') missing.push('agency_not_active');
  if (f.fingerprintStatus !== 'cleared' || !f.fingerprintAdjudicatedOn)
    missing.push('fingerprint_check');
  const day = today.toISOString().slice(0, 10);
  if (!f.trainingExpiresOn || f.trainingExpiresOn.toISOString().slice(0, 10) <= day)
    missing.push('security_training');
  if (f.roles.length === 0) missing.push('role');
  return { qualified: missing.length === 0, missing };
}

export interface EnclaveSubject {
  personId: string;
  agencyId: string;
  roles: readonly EnclaveRole[];
  qualified: boolean;
  missing: readonly Missing[];
}

export interface EnclaveResource {
  type: string;
  id?: string;
  agencyId?: string;
  /** For a role request: who asked, and whom it is about (E5). */
  requestedBy?: string;
  aboutPersonId?: string;
  /** For a disposition review: who recorded it (E6). */
  recordedBy?: string | null;
  /** Mutual aid: the owner shares this record with the subject's agency now (E3 reads only). */
  sharedWithSubject?: boolean;
}

export interface EnclaveDecision {
  effect: 'allow' | 'deny';
  reason: string;
  consequential: boolean;
  /** A refusal the caller may see as such (403) rather than as "not found". */
  visibleRefusal: boolean;
}

const deny = (reason: string, consequential = false, visibleRefusal = false): EnclaveDecision => ({
  effect: 'deny',
  reason,
  consequential,
  visibleRefusal,
});

export function decide(
  subject: EnclaveSubject,
  actionKey: string,
  resource: EnclaveResource,
): EnclaveDecision {
  if (!isEnclaveAction(actionKey)) return deny('E1:unknown_action');
  const action: EnclaveAction = ENCLAVE_ACTIONS[actionKey];
  const consequential = action.consequential === true;
  if (!action.unqualified && !subject.qualified)
    return deny(`E2:not_qualified:${subject.missing.join(',')}`, consequential, true);
  if (resource.agencyId && resource.agencyId !== subject.agencyId) {
    if (!(resource.sharedWithSubject && action.kind === 'read'))
      return deny('E3:other_agency', consequential);
  }
  if (resource.type === 'audit_event' && action.kind !== 'read' && action.kind !== 'export')
    return deny('E4:audit_immutable', consequential, true);
  if (actionKey === 'permission.decide' && resource.requestedBy === subject.personId)
    return deny('E5:second_administrator_required', consequential, true);
  if (SELF_FORBIDDEN.includes(actionKey) && resource.aboutPersonId === subject.personId)
    return deny('E5:own_account', consequential, true);
  if (actionKey === 'record.review' && resource.recordedBy === subject.personId)
    return deny('E6:own_disposition', consequential, true);
  if (action.unqualified)
    return { effect: 'allow', reason: 'self', consequential, visibleRefusal: false };
  const held = action.roles.find((r) => subject.roles.includes(r));
  if (!held) return deny('no_role', consequential);
  return { effect: 'allow', reason: `role:${held}`, consequential, visibleRefusal: false };
}
