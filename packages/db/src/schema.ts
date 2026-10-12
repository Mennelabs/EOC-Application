/**
 * Kysely table types for schema cg (layer 1). Keep in step with the migrations
 * and with dictionary.ts; the integration suite checks the database side.
 */
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

type Ts = ColumnType<Date, Date | string, Date | string>;
type TsNullable = ColumnType<Date | null, Date | string | null, Date | string | null>;
type Uuid = string;
/** Free-form JSON (any JSON value): inserts pass JSON.stringify(value). */
type JsonValue = ColumnType<unknown, string, string>;

interface Stamped {
  version: Generated<number>;
  created_at: Generated<Ts>;
  created_by: Uuid | null;
  updated_at: Generated<Ts>;
  updated_by: Uuid | null;
}

export type TenantKind = 'state' | 'region' | 'county' | 'city' | 'partner_org';
export type TenantStatus = 'active' | 'suspended' | 'closed';

export interface TenantTable extends Stamped {
  id: Generated<Uuid>;
  kind: TenantKind;
  parent_id: Uuid | null;
  path: Generated<string>;
  slug: string;
  name: string;
  timezone: Generated<string>;
  locales: Generated<string[]>;
  status: Generated<TenantStatus>;
  security_contact_email: string | null;
  branding: Generated<JSONColumnType<Record<string, unknown>>>;
}

export interface JurisdictionTable extends Stamped {
  tenant_id: Uuid;
  fips: string | null;
  geom: ColumnType<unknown, unknown, unknown> | null;
}

export interface LicenseTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  tier: string;
  population_served: number | null;
  term_start: ColumnType<Date, string, string>;
  term_end: ColumnType<Date, string, string>;
  covers_tenant_ids: Generated<Uuid[]>;
  status: Generated<'active' | 'expired' | 'cancelled'>;
}

export type DsaScope = 'deidentified_counts' | 'consented_records' | 'full_records';

export interface DataSharingAgreementTable extends Stamped {
  id: Generated<Uuid>;
  from_tenant_id: Uuid;
  to_tenant_id: Uuid;
  scope: DsaScope;
  data_categories: Generated<string[]>;
  status: Generated<'draft' | 'signed' | 'revoked'>;
  terms: Generated<JSONColumnType<Record<string, unknown>>>;
  signed_at: TsNullable;
  signed_by: Uuid | null;
  revoked_at: TsNullable;
  revoked_by: Uuid | null;
}

export interface TenantConfigTable extends Stamped {
  tenant_id: Uuid;
  key: string;
  value: JsonValue;
}

export interface TenantConfigHistoryTable {
  id: Generated<number>;
  tenant_id: Uuid;
  key: string;
  version: number;
  value: JsonValue;
  changed_at: Generated<Ts>;
  changed_by: Uuid | null;
  reason: string | null;
}

export interface EventTemplateTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  hazard_type: string;
  name: string;
  config: Generated<JSONColumnType<Record<string, unknown>>>;
}

export type EventStatus = 'draft' | 'active' | 'closed';

export interface EventTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  template_id: Uuid | null;
  name: string;
  hazard_type: string;
  status: Generated<EventStatus>;
  intake_slug: string | null;
  intake_keywords: Generated<string[]>;
  opened_at: TsNullable;
  closed_at: TsNullable;
  close_reason: string | null;
  footprint: ColumnType<unknown, unknown, unknown> | null;
}

export interface EventParticipantTable {
  event_id: Uuid;
  tenant_id: Uuid;
  role: Generated<string>;
  added_at: Generated<Ts>;
  added_by: Uuid | null;
}

export type AccountStatus = 'invited' | 'active' | 'suspended' | 'deactivated';

export interface AccountTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  idp_subject: string | null;
  email: string;
  display_name: string;
  status: Generated<AccountStatus>;
  invited_at: Generated<Ts>;
  activated_at: TsNullable;
  suspended_at: TsNullable;
  deactivated_at: TsNullable;
  last_login_at: TsNullable;
}

export interface AccountLifecycleTable {
  id: Generated<number>;
  tenant_id: Uuid;
  account_id: Uuid;
  from_status: AccountStatus | null;
  to_status: AccountStatus;
  reason: string | null;
  actor_account_id: Uuid | null;
  at: Generated<Ts>;
}

export interface PersonnelTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  account_id: Uuid | null;
  name: string;
  agency: string | null;
  department: string | null;
  operational_role: string | null;
  skills: Generated<string[]>;
  duty_status: Generated<'off_duty' | 'on_duty'>;
  availability: Generated<'unavailable' | 'available' | 'assigned'>;
  status: Generated<'active' | 'inactive' | 'archived'>;
  contact_enc: Buffer | null;
  phone_bidx: Buffer | null;
}

export interface RoleTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  key: string;
  name: string;
  description: string | null;
  template_key: string | null;
  current_version: Generated<number>;
  status: Generated<'active' | 'retired'>;
}

export interface RoleVersionTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  role_id: Uuid;
  version: number;
  grants: JsonValue;
  change_reason: string | null;
  created_at: Generated<Ts>;
  created_by: Uuid | null;
}

export interface RoleAssignmentTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  account_id: Uuid;
  role_id: Uuid;
  scope: Generated<JSONColumnType<Record<string, unknown>>>;
  valid_from: Generated<Ts>;
  valid_to: TsNullable;
  status: Generated<'active' | 'revoked'>;
  granted_by: Uuid;
  approved_by: Uuid;
  change_request_id: Uuid | null;
  revoked_at: TsNullable;
  revoked_by: Uuid | null;
  revoke_reason: string | null;
}

export type ChangeRequestStatus =
  'pending' | 'approved' | 'rejected' | 'applied' | 'expired' | 'withdrawn';

export interface PermissionChangeRequestTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  kind: 'assign_role' | 'revoke_role' | 'publish_role_version';
  payload: JSONColumnType<Record<string, unknown>>;
  requested_by: Uuid;
  requested_at: Generated<Ts>;
  status: Generated<ChangeRequestStatus>;
  decided_by: Uuid | null;
  decided_at: TsNullable;
  decision_reason: string | null;
  applied_at: TsNullable;
  expires_at: Generated<Ts>;
}

export interface BreakGlassSessionTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  account_id: Uuid;
  reason: string;
  started_at: Generated<Ts>;
  expires_at: Ts;
  ended_at: TsNullable;
  ended_by: Uuid | null;
  notified_at: TsNullable;
  notified_to: string | null;
}

export type ActorKind = 'account' | 'break_glass' | 'public' | 'system';

export interface AuditEventTable {
  seq: Generated<number>;
  tenant_id: Uuid;
  occurred_at: Generated<Ts>;
  recorded_at: Generated<Ts>;
  actor_account_id: Uuid | null;
  actor_kind: ActorKind;
  action: string;
  target_type: string;
  target_id: string;
  target_version: number | null;
  changes: JsonValue | null;
  execution_id: Uuid | null;
  request_id: string | null;
  classification_read: Generated<string[]>;
  reason: string | null;
  prev_hash: Generated<Buffer | null>;
  hash: Generated<Buffer>;
}

export interface AuditAnchorTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  through_seq: number;
  hash: Buffer;
  anchored_at: Generated<Ts>;
  object_key: string | null;
}

export interface DataDictionaryTable {
  table_name: string;
  column_name: string;
  classification: 'public' | 'internal' | 'sensitive' | 'restricted' | 'cji';
  retention_category: Generated<string>;
  description: string | null;
}

export interface TenantKeyTable {
  tenant_id: Uuid;
  key_version: number;
  kek_name: string;
  wrapped_dek: string;
  status: Generated<'active' | 'retired'>;
  created_at: Generated<Ts>;
  retired_at: TsNullable;
}

export interface RetentionPolicyTable extends Stamped {
  tenant_id: Uuid;
  data_category: string;
  keep_for: ColumnType<string | null, string | null, string | null>;
  rule: Generated<'duration' | 'on_confirm' | 'external'>;
  note: string | null;
}

export interface LegalHoldTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  scope: JSONColumnType<Record<string, unknown>>;
  reason: string;
  placed_by: Uuid;
  placed_at: Generated<Ts>;
  released_by: Uuid | null;
  released_at: TsNullable;
}

export interface DeletionLogTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  data_category: string;
  target_type: string;
  deleted_count: number;
  oldest: TsNullable;
  newest: TsNullable;
  ran_at: Generated<Ts>;
  execution_id: Uuid;
}

export interface IdempotencyKeyTable {
  tenant_id: Uuid;
  scope: string;
  key: string;
  request_hash: Buffer;
  status: Generated<'in_progress' | 'completed'>;
  response_status: number | null;
  response_body: JsonValue | null;
  created_at: Generated<Ts>;
  expires_at: Generated<Ts>;
}

export interface GovernedDefinitionTable {
  tenant_id: Uuid;
  key: string;
  version: number;
  value: JsonValue;
  reason: string | null;
  effective_from: Generated<Ts>;
  created_at: Generated<Ts>;
  created_by: Uuid | null;
}

export interface OutboxTable {
  id: Generated<number>;
  tenant_id: Uuid;
  topic: string;
  payload: JsonValue;
  execution_id: Uuid | null;
  created_at: Generated<Ts>;
  published_at: TsNullable;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface Database {
  'cg.tenant': TenantTable;
  'cg.jurisdiction': JurisdictionTable;
  'cg.license': LicenseTable;
  'cg.data_sharing_agreement': DataSharingAgreementTable;
  'cg.tenant_config': TenantConfigTable;
  'cg.tenant_config_history': TenantConfigHistoryTable;
  'cg.event_template': EventTemplateTable;
  'cg.event': EventTable;
  'cg.event_participant': EventParticipantTable;
  'cg.account': AccountTable;
  'cg.account_lifecycle': AccountLifecycleTable;
  'cg.personnel': PersonnelTable;
  'cg.role': RoleTable;
  'cg.role_version': RoleVersionTable;
  'cg.role_assignment': RoleAssignmentTable;
  'cg.permission_change_request': PermissionChangeRequestTable;
  'cg.break_glass_session': BreakGlassSessionTable;
  'cg.audit_event': AuditEventTable;
  'cg.audit_anchor': AuditAnchorTable;
  'cg.data_dictionary': DataDictionaryTable;
  'cg.tenant_key': TenantKeyTable;
  'cg.retention_policy': RetentionPolicyTable;
  'cg.legal_hold': LegalHoldTable;
  'cg.deletion_log': DeletionLogTable;
  'cg.idempotency_key': IdempotencyKeyTable;
  'cg.governed_definition': GovernedDefinitionTable;
  'cg.outbox': OutboxTable;
}
