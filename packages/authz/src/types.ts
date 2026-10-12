/**
 * Policy engine types (ADR-0011). The engine is pure: decide(subject, action,
 * resource) returns a Decision and never touches a database. Callers build the
 * subject from a fresh token and role lookup on every request (AC-C05).
 */
export type Classification = 'public' | 'internal' | 'sensitive' | 'restricted' | 'cji';

/**
 * Data categories group fields for permission purposes (SEC-11, ADM-04).
 * 'basic' is always visible when the action is allowed. The categories in
 * TEMPLATE_PROTECTED_CATEGORIES can never be granted by a county role editor;
 * only shipped role templates carry them (ADM-05 guardrail 7, RULE-16).
 */
export type DataCategory =
  | 'basic'
  | 'contact'
  | 'location_exact'
  | 'household'
  | 'free_text'
  | 'financial'
  | 'evidence'
  | 'access_needs'
  | 'health'
  | 'counseling'
  | 'legal'
  | 'cji';

export const DATA_CATEGORIES: readonly DataCategory[] = [
  'basic',
  'contact',
  'location_exact',
  'household',
  'free_text',
  'financial',
  'evidence',
  'access_needs',
  'health',
  'counseling',
  'legal',
  'cji',
];

export const TEMPLATE_PROTECTED_CATEGORIES: readonly DataCategory[] = [
  'access_needs',
  'health',
  'counseling',
  'legal',
];

export interface FieldDescriptor {
  name: string;
  category: DataCategory;
  classification: Classification;
}

export type TenantScope = 'own' | 'subtree' | string[];
export type EventScope = 'all' | 'assigned';

/** One line of a role: an action pattern with the scope it applies to. */
export interface Grant {
  /** Exact action key ('event.read'), a family ('event.*') or everything ('*'). */
  action: string;
  /** Which tenants' records; default 'own'. */
  tenants?: TenantScope;
  /** Which events; default 'all'. 'assigned' = events named in the assignment scope. */
  events?: EventScope;
  /** Field categories visible beyond 'basic'; default none. */
  dataCategories?: DataCategory[];
}

export interface ResolvedRole {
  roleId: string;
  key: string;
  version: number;
  templateKey: string | null;
  grants: Grant[];
  /** Assignment scope, e.g. events the holder is assigned to. */
  scope: { eventIds?: string[] };
}

export type AccountStatus = 'invited' | 'active' | 'suspended' | 'deactivated';

export interface AccountSubject {
  kind: 'account';
  accountId: string;
  tenantId: string;
  tenantPath: string;
  status: AccountStatus;
  roles: ResolvedRole[];
  /** Tenants whose signed agreements grant this tenant read access (SCL-01). */
  agreementTenantIds?: string[];
  breakGlass?: { id: string; expiresAt: Date };
  /** True only for a verified CJIS enclave session (SEC-12). Never set by the platform. */
  enclaveSession?: boolean;
  /** When the roles were loaded; stale subjects are refused (AC-C05). */
  resolvedAt: Date;
}

export interface PublicSubject {
  kind: 'public';
  tenantId?: string;
  /** Set after reference code + one-time code verification (SEC-09): the one report this subject may read. */
  resident?: { reportId: string };
}

export interface SystemSubject {
  kind: 'system';
  tenantId: string;
  job: string;
}

export type Subject = AccountSubject | PublicSubject | SystemSubject;

export interface Resource {
  type: string;
  id?: string;
  tenantId?: string;
  tenantPath?: string;
  eventId?: string;
  /** Account that recorded the finding; used by the self-review guardrail (A7). */
  recordedBy?: string;
  /** For permission change requests: who asked (second-administrator rule). */
  requestedBy?: string;
  /** For role assignments: the approved change request that authorises them. */
  changeRequestId?: string;
  changeRequestApproved?: boolean;
  /** For public resources: only published ones are readable without sign-in. */
  published?: boolean;
  fields?: FieldDescriptor[];
}

export interface TenantPolicy {
  /** A7: only with an explicit, audited policy exception may someone approve their own finding. */
  selfReviewException?: boolean;
  /** Max age of a resolved subject before it must be rebuilt (ms). */
  maxSubjectAgeMs?: number;
}

export interface Decision {
  effect: 'allow' | 'deny';
  /** Machine-readable reason: 'guardrail:G3', 'grant:role_key@2', 'break_glass', 'no_grant', ... */
  reason: string;
  guardrail?: GuardrailId;
  /** Names of the fields the caller may return or write (all requested fields if none described). */
  fields: string[];
  maskedFields: string[];
  /** Restricted categories being read, for the audit record (SEC-18). */
  restrictedRead: DataCategory[];
  /** RULE-14: needs confirmation and a reason at the API layer. */
  consequential: boolean;
  /** Extra audit context, e.g. 'self_review_exception' or 'break_glass'. */
  auditReason?: string;
}

export type GuardrailId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';

export const NOW = (): Date => new Date();
