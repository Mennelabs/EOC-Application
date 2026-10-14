/**
 * Kysely table types for schema `cjis` (the enclave database). Generated
 * columns are `Generated<…>`; encrypted CJI columns end in `_enc` and hold
 * the AES-GCM blob from @cg/crypto under the agency key (SEC-10).
 */
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

export interface AgencyTable {
  id: Generated<string>;
  name: string;
  agency_identifier: string;
  platform_county: string | null;
  status: Generated<'active' | 'suspended'>;
  exercise: Generated<boolean>;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface DataDictionaryTable {
  table_name: string;
  column_name: string;
  classification: string;
  retention_category: string;
  description: string | null;
}

export type EnclaveRole =
  'officer' | 'supervisor' | 'records_clerk' | 'agency_admin' | 'security_officer' | 'auditor';

export const ENCLAVE_ROLES: readonly EnclaveRole[] = [
  'officer',
  'supervisor',
  'records_clerk',
  'agency_admin',
  'security_officer',
  'auditor',
];

export interface AgencyKeyTable {
  agency_id: string;
  version: number;
  wrapped: string;
  kek_name: string;
  created_at: CreatedAt;
}

export type PersonStatus = 'invited' | 'active' | 'suspended' | 'deactivated';
export type FingerprintStatus = 'not_started' | 'pending' | 'cleared' | 'denied';

export interface PersonTable {
  id: Generated<string>;
  agency_id: string;
  idp_subject: string | null;
  email: string;
  display_name: string;
  status: Generated<PersonStatus>;
  status_reason: string | null;
  fingerprint_status: Generated<FingerprintStatus>;
  fingerprint_adjudicated_on: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  fingerprint_recorded_by: string | null;
  training_completed_on: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  training_expires_on: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  training_recorded_by: string | null;
  identity_state: Generated<'none' | 'pending' | 'created' | 'failed'>;
  last_seen_at: Date | null;
  version: Generated<number>;
  created_at: CreatedAt;
  created_by: string | null;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface PermissionRequestTable {
  id: Generated<string>;
  agency_id: string;
  person_id: string;
  role: EnclaveRole;
  change: 'grant' | 'revoke';
  status: Generated<'pending' | 'approved' | 'rejected' | 'withdrawn'>;
  reason: string;
  requested_by: string;
  requested_at: CreatedAt;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface RoleGrantTable {
  id: Generated<string>;
  agency_id: string;
  person_id: string;
  role: EnclaveRole;
  status: Generated<'active' | 'revoked'>;
  request_id: string | null;
  granted_by: string | null;
  granted_at: CreatedAt;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoke_request_id: string | null;
  version: Generated<number>;
  updated_at: Timestamp;
}

export interface IdentityOutboxTable {
  id: Generated<string>;
  agency_id: string;
  person_id: string;
  kind: 'create_user' | 'disable_user' | 'enable_user';
  payload_enc: Buffer | null;
  status: Generated<'pending' | 'done' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  next_attempt_at: Timestamp;
  created_at: CreatedAt;
  done_at: Date | null;
}

export interface IdpEventCursorTable {
  id: number;
  last_time_ms: ColumnType<string, string | number, string | number>;
  updated_at: Timestamp;
}

export type RecordOrigin =
  '911' | 'non_emergency' | 'officer_initiated' | 'walk_in' | 'text' | 'radio' | 'other';
export type RecordDisposition =
  | 'arrest_made'
  | 'citation_issued'
  | 'report_filed'
  | 'no_action_taken'
  | 'transported'
  | 'referred'
  | 'completed';

export interface RecordTable {
  id: Generated<string>;
  agency_id: string;
  cji_ref: string;
  platform_county: string | null;
  platform_mission_reference: string | null;
  origin: RecordOrigin | null;
  classification: string | null;
  offense_codes: Generated<string[]>;
  case_number_enc: Buffer | null;
  summary_enc: Buffer | null;
  state: Generated<'open' | 'closed'>;
  disposition: RecordDisposition | null;
  disposition_note_enc: Buffer | null;
  disposition_by: string | null;
  disposition_at: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  closed_at: Date | null;
  version: Generated<number>;
  created_at: CreatedAt;
  created_by: string | null;
  updated_at: Timestamp;
  updated_by: string | null;
}

interface Removable {
  status: Generated<'active' | 'removed'>;
  removed_reason: string | null;
  removed_by: string | null;
  removed_at: Date | null;
  version: Generated<number>;
  created_at: CreatedAt;
  created_by: string | null;
  updated_at: Timestamp;
  updated_by: string | null;
}

export type PersonInvolvedRole =
  | 'suspect'
  | 'arrestee'
  | 'victim'
  | 'witness'
  | 'complainant'
  | 'subject'
  | 'reporting_party'
  | 'other';

export interface RecordPersonTable extends Removable {
  id: Generated<string>;
  agency_id: string;
  record_id: string;
  role: PersonInvolvedRole;
  name_enc: Buffer;
  birth_date_enc: Buffer | null;
  demographics_enc: Buffer | null;
  contact_enc: Buffer | null;
  address_enc: Buffer | null;
  identifiers_enc: Buffer | null;
  notes_enc: Buffer | null;
}

export interface RecordWeaponTable extends Removable {
  id: Generated<string>;
  agency_id: string;
  record_id: string;
  person_id: string | null;
  kind: 'firearm' | 'edged' | 'blunt' | 'explosive' | 'other' | 'unknown';
  description_enc: Buffer | null;
  serial_enc: Buffer | null;
  disposition: Generated<'observed' | 'seized' | 'returned' | 'unknown'>;
}

export interface RecordBodycamTable extends Removable {
  id: Generated<string>;
  agency_id: string;
  record_id: string;
  camera_label: string;
  officer_person_id: string | null;
  recorded_from: Date | string | null;
  recorded_to: Date | string | null;
  evidence_reference_enc: Buffer;
  notes_enc: Buffer | null;
}

export type RecordEventKind =
  | 'created'
  | 'updated'
  | 'narrative'
  | 'amendment'
  | 'person_added'
  | 'person_updated'
  | 'person_removed'
  | 'weapon_added'
  | 'weapon_updated'
  | 'weapon_removed'
  | 'bodycam_added'
  | 'bodycam_updated'
  | 'bodycam_removed'
  | 'disposition'
  | 'reviewed'
  | 'reopened';

export interface RecordEventTable {
  id: Generated<string>;
  agency_id: string;
  record_id: string;
  kind: RecordEventKind;
  narrative_role: 'officer' | 'supervisor' | 'records' | null;
  body_enc: Buffer | null;
  amends_event_id: string | null;
  actor_person_id: string | null;
  detail: ColumnType<unknown, string | undefined, string>;
  occurred_at: Timestamp;
  created_at: CreatedAt;
}

export interface IdempotencyKeyTable {
  agency_id: string;
  scope: string;
  key: string;
  request_hash: Buffer;
  status: Generated<'in_progress' | 'completed'>;
  response_status: number | null;
  response_body_enc: Buffer | null;
  expires_at: Timestamp;
  created_at: CreatedAt;
}

export type AuditOutcome = 'success' | 'denied' | 'failure';
export type AuditActorKind = 'person' | 'system' | 'identity_provider' | 'anonymous';

export interface AuditEventTable {
  seq: Generated<string>;
  agency_id: string | null;
  occurred_at: Timestamp;
  recorded_at: Generated<Date>;
  actor_person_id: string | null;
  actor_kind: AuditActorKind;
  action: string;
  target_type: string;
  target_id: string;
  target_version: number | null;
  outcome: AuditOutcome;
  reason: string | null;
  fields: Generated<string[]>;
  request_id: string | null;
  source_ip: string | null;
  prev_hash: Generated<Buffer | null>;
  hash: Generated<Buffer>;
}

export interface AuditReviewTable {
  id: Generated<string>;
  agency_id: string;
  reviewer_person_id: string;
  period_from: Timestamp;
  period_to: Timestamp;
  checked: number;
  chain_ok: boolean;
  note: string;
  created_at: CreatedAt;
}

export interface RetentionPolicyTable {
  agency_id: string;
  category: 'records' | 'audit';
  keep_days: number;
  basis: string;
  version: Generated<number>;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface LegalHoldTable {
  id: Generated<string>;
  agency_id: string;
  record_id: string | null;
  reason: string;
  placed_by: string;
  placed_at: CreatedAt;
  released_by: string | null;
  released_at: Date | null;
  release_reason: string | null;
  version: Generated<number>;
  updated_at: Timestamp;
}

export interface DeletionLogTable {
  id: Generated<string>;
  agency_id: string;
  category: string;
  cutoff: Date;
  deleted: number;
  held: number;
  ran_at: CreatedAt;
}

export interface CjisDatabase {
  'cjis.agency': AgencyTable;
  'cjis.data_dictionary': DataDictionaryTable;
  'cjis.agency_key': AgencyKeyTable;
  'cjis.person': PersonTable;
  'cjis.permission_request': PermissionRequestTable;
  'cjis.role_grant': RoleGrantTable;
  'cjis.identity_outbox': IdentityOutboxTable;
  'cjis.idp_event_cursor': IdpEventCursorTable;
  'cjis.record': RecordTable;
  'cjis.record_person': RecordPersonTable;
  'cjis.record_weapon': RecordWeaponTable;
  'cjis.record_bodycam': RecordBodycamTable;
  'cjis.record_event': RecordEventTable;
  'cjis.idempotency_key': IdempotencyKeyTable;
  'cjis.audit_event': AuditEventTable;
  'cjis.audit_review': AuditReviewTable;
  'cjis.retention_policy': RetentionPolicyTable;
  'cjis.legal_hold': LegalHoldTable;
  'cjis.deletion_log': DeletionLogTable;
}
