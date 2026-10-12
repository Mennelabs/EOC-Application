/**
 * Kysely table types for schema cg (layer 1). Keep in step with the migrations
 * and with dictionary.ts; the integration suite checks the database side.
 */
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

type Ts = ColumnType<Date, Date | string, Date | string>;
/** Timestamp with a database default: optional on insert. (Generated<> must not wrap a ColumnType.) */
type TsGen = ColumnType<Date, Date | string | undefined, Date | string>;
/** JSON object with a database default: optional on insert, passed as JSON.stringify(value). */
type JsonGen<T extends object> = ColumnType<T, string | undefined, string>;
type TsNullable = ColumnType<Date | null, Date | string | null, Date | string | null>;
type Uuid = string;
/** Free-form JSON (any JSON value): inserts pass JSON.stringify(value). */
type JsonValue = ColumnType<unknown, string, string>;

interface Stamped {
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export type TenantKind = 'state' | 'region' | 'county' | 'city' | 'partner_org';
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'closed';

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
  branding: JsonGen<Record<string, unknown>>;
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
  terms: JsonGen<Record<string, unknown>>;
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
  changed_at: TsGen;
  changed_by: Uuid | null;
  reason: string | null;
}

export interface EventTemplateTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  hazard_type: string;
  name: string;
  config: JsonGen<Record<string, unknown>>;
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
  added_at: TsGen;
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
  invited_at: TsGen;
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
  at: TsGen;
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
  created_at: TsGen;
  created_by: Uuid | null;
}

export interface RoleAssignmentTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  account_id: Uuid;
  role_id: Uuid;
  scope: JsonGen<Record<string, unknown>>;
  valid_from: TsGen;
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
  requested_at: TsGen;
  status: Generated<ChangeRequestStatus>;
  decided_by: Uuid | null;
  decided_at: TsNullable;
  decision_reason: string | null;
  applied_at: TsNullable;
  expires_at: TsGen;
}

export interface BreakGlassSessionTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  account_id: Uuid;
  reason: string;
  started_at: TsGen;
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
  occurred_at: TsGen;
  recorded_at: TsGen;
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
  anchored_at: TsGen;
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
  created_at: TsGen;
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
  placed_at: TsGen;
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
  ran_at: TsGen;
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
  created_at: TsGen;
  expires_at: TsGen;
}

export interface GovernedDefinitionTable {
  tenant_id: Uuid;
  key: string;
  version: number;
  value: JsonValue;
  reason: string | null;
  effective_from: TsGen;
  created_at: TsGen;
  created_by: Uuid | null;
}

export interface OutboxTable {
  id: Generated<number>;
  tenant_id: Uuid;
  topic: string;
  payload: JsonValue;
  execution_id: Uuid | null;
  created_at: TsGen;
  published_at: TsNullable;
  attempts: Generated<number>;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Layer 2: intake, reports, review (migrations 0011–0016)
// ---------------------------------------------------------------------------

export type IntakeChannel = 'web' | 'sms' | 'voice' | 'assisted';
export type Relationship = 'own_home' | 'helper' | 'witness' | 'organization';
export type ReviewState =
  | 'submitted'
  | 'under_review'
  | 'needs_information'
  | 'approved'
  | 'rejected'
  | 'duplicate'
  | 'superseded';
export type VerificationLevel =
  'self_reported' | 'desktop_verified' | 'field_verified' | 'cannot_verify';
export type FemaDegree = 'affected' | 'minor' | 'major' | 'destroyed' | 'no_damage' | 'cannot_tell';
export type ReviewDecisionKind =
  | 'approve'
  | 'reject'
  | 'needs_information'
  | 'duplicate'
  | 'supersede'
  | 'reopen'
  | 'verify'
  | 'set_degree';
export type MessageState = 'queued' | 'sent' | 'delivered' | 'acknowledged' | 'failed';

export interface IntakeGraphTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  key: string;
  graph_version: number;
  status: Generated<'draft' | 'published' | 'retired'>;
  graph: JsonValue;
  hazards: Generated<string[]>;
  languages: Generated<string[]>;
  change_reason: string | null;
  published_at: TsNullable;
  published_by: Uuid | null;
}

export interface ReferenceCodeTable {
  tenant_id: Uuid;
  code: string;
  state: Generated<'free' | 'leased' | 'used'>;
  leased_by: string | null;
  leased_at: TsNullable;
  execution_id: Uuid | null;
  report_id: Uuid | null;
  created_at: TsGen;
}

export interface IntakeSubmissionTable {
  execution_id: Uuid;
  tenant_id: Uuid;
  event_id: Uuid | null;
  channel: IntakeChannel;
  reference_code: string;
  payload_enc: Buffer;
  status: Generated<'queued' | 'stored' | 'processed' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  received_at: TsGen;
  processed_at: TsNullable;
}

export interface PartyTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  kind: 'resident' | 'helper' | 'witness' | 'organization';
  display_name_enc: Buffer | null;
  contact_enc: Buffer | null;
  phone_bidx: Buffer | null;
  email_bidx: Buffer | null;
  language: Generated<string>;
  sms_opt_in: Generated<boolean>;
  sms_opt_in_evidence: JsonValue | null;
}

export interface LocationTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  line1: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  landmark: string | null;
  note: string | null;
  no_fixed_address: Generated<boolean>;
  geom: ColumnType<unknown, unknown, unknown> | null;
  precision: Generated<'exact' | 'approximate' | 'area' | 'unknown'>;
  source: Generated<'resident' | 'geocoder' | 'reviewer' | 'field'>;
  parcel_id: string | null;
  usng: string | null;
}

export interface ReportTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  reference_code: string;
  execution_id: Uuid;
  event_id: Uuid | null;
  graph_key: string;
  graph_version: number;
  channel_of_origin: IntakeChannel;
  channels_used: Generated<string[]>;
  relationship: Relationship;
  reporter_party_id: Uuid | null;
  subject_party_id: Uuid | null;
  helper_party_id: Uuid | null;
  location_id: Uuid | null;
  answers: JsonGen<Record<string, unknown>>;
  answers_enc: Buffer | null;
  original_text_enc: Buffer | null;
  original_lang: string | null;
  translation_enc: Buffer | null;
  translation_provider: string | null;
  extraction_id: Uuid | null;
  review_state: Generated<ReviewState>;
  verification_level: Generated<VerificationLevel>;
  fema_degree: FemaDegree | null;
  fema_degree_set_by: Uuid | null;
  fema_degree_set_at: TsNullable;
  is_primary_residence: boolean | null;
  pre_existing_damage: boolean | null;
  duplicate_of: Uuid | null;
  supersedes: Uuid | null;
  need_signals: JsonGen<Record<string, boolean>>;
  danger_flag: Generated<boolean>;
  told_to_call_911_at: TsNullable;
  submitted_at: TsGen;
  withdrawn_at: TsNullable;
}

export interface ReportVersionTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid;
  report_version: number;
  snapshot: JsonValue;
  changed_by_kind: 'resident' | 'reviewer' | 'system';
  changed_by: Uuid | null;
  reason: string | null;
  created_at: TsGen;
}

export interface ReviewDecisionTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid;
  report_version: number;
  reviewer_account_id: Uuid;
  decision: ReviewDecisionKind;
  reason: string;
  evidence_refs: JsonGen<unknown[]>;
  ai_suggestion_id: Uuid | null;
  agreed_with_ai: boolean | null;
  created_at: TsGen;
}

export interface CorrectionRequestTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid;
  questions: JsonValue;
  message: string | null;
  sent_via: 'sms' | 'email' | 'voice' | 'none' | null;
  requested_by: Uuid;
  requested_at: TsGen;
  answered_at: TsNullable;
  resolution: 'answered' | 'withdrawn' | 'expired' | null;
}

export interface PhotoTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  execution_id: Uuid;
  report_id: Uuid | null;
  shot: Generated<string>;
  source: Generated<'web' | 'mms' | 'assisted' | 'field'>;
  object_key_original: string;
  derivative_keys: JsonGen<Record<string, string>>;
  exif_stripped: Generated<boolean>;
  blur_status: Generated<'pending' | 'applied' | 'skipped_no_detector' | 'failed'>;
  status: Generated<'uploading' | 'uploaded' | 'processed' | 'failed' | 'rejected'>;
  content_type: string | null;
  width: number | null;
  height: number | null;
  bytes: ColumnType<string | number, number | string, number | string> | null;
  sha256: Buffer | null;
  suggested_taken_at: TsNullable;
  suggested_geom: ColumnType<unknown, unknown, unknown> | null;
  uploaded_at: TsNullable;
  processed_at: TsNullable;
}

export interface NeedTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid | null;
  subject_party_id: Uuid | null;
  event_id: Uuid | null;
  category: string;
  detail: string | null;
  status: Generated<'open' | 'claimed' | 'met' | 'closed' | 'withdrawn'>;
}

export interface ConsentTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  party_id: Uuid;
  report_id: Uuid | null;
  org_type: string;
  granted: Generated<boolean>;
  granted_at: TsNullable;
  withdrawn_at: TsNullable;
  channel: 'web' | 'sms' | 'voice' | 'assisted' | 'staff' | null;
  evidence: JsonValue | null;
}

export interface PostSubmissionAnswersTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid;
  aggregate_answers: JsonGen<Record<string, unknown>>;
  restricted_answers_enc: Buffer | null;
}

export interface DraftTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  resume_code_hash: Buffer;
  execution_id: Uuid;
  payload_enc: Buffer;
  expires_at: Ts;
  consumed_at: TsNullable;
  created_at: TsGen;
}

export interface OtpChallengeTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid;
  contact_bidx: Buffer;
  channel: 'sms' | 'email';
  code_hash: Buffer;
  attempts: Generated<number>;
  expires_at: Ts;
  consumed_at: TsNullable;
  created_at: TsGen;
}

export interface IntakeSessionTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  channel: 'sms' | 'voice';
  phone_bidx: Buffer;
  phone_enc: Buffer;
  event_id: Uuid | null;
  language: Generated<string>;
  graph_key: string;
  graph_version: number;
  cursor: string | null;
  answers_enc: Buffer | null;
  execution_id: Uuid;
  state: Generated<'active' | 'paused' | 'submitted' | 'stopped' | 'expired'>;
  opt_out: Generated<boolean>;
  last_inbound_at: TsGen;
}

export interface MessageTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  channel: 'sms' | 'mms' | 'voice' | 'email';
  to_bidx: Buffer | null;
  to_enc: Buffer;
  template: string;
  body_enc: Buffer;
  state: Generated<MessageState>;
  provider: string | null;
  provider_message_id: string | null;
  provider_evidence: JsonGen<Record<string, unknown>>;
  error: string | null;
  report_id: Uuid | null;
  party_id: Uuid | null;
  queued_at: TsGen;
  sent_at: TsNullable;
  delivered_at: TsNullable;
  failed_at: TsNullable;
}

export interface AbuseSignalTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  kind: string;
  subject_hash: Buffer;
  execution_id: Uuid | null;
  score: Generated<number>;
  decision: 'allow' | 'verify' | 'deny';
  details: JsonGen<Record<string, unknown>>;
  created_at: TsGen;
}

export interface AiUseRegisterTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  feature: string;
  provider: string;
  model: string;
  model_version: string | null;
  data_sent: string;
  decision_informed: string;
  human_checkpoint: string;
  owner: string;
  us_region: Generated<boolean>;
  zero_retention: Generated<boolean>;
  no_training: Generated<boolean>;
  evaluation: JsonGen<Record<string, unknown>>;
  enabled: Generated<boolean>;
}

export interface ExtractionTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  execution_id: Uuid;
  input_hash: Buffer;
  provider: string;
  model: string;
  output: JsonValue;
  confirmed: JsonValue | null;
  rejected: JsonValue | null;
  filtered_reasons: Generated<string[]>;
  created_at: TsGen;
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
  'cg.intake_graph': IntakeGraphTable;
  'cg.reference_code': ReferenceCodeTable;
  'cg.intake_submission': IntakeSubmissionTable;
  'cg.party': PartyTable;
  'cg.location': LocationTable;
  'cg.report': ReportTable;
  'cg.report_version': ReportVersionTable;
  'cg.review_decision': ReviewDecisionTable;
  'cg.correction_request': CorrectionRequestTable;
  'cg.photo': PhotoTable;
  'cg.need': NeedTable;
  'cg.consent': ConsentTable;
  'cg.post_submission_answers': PostSubmissionAnswersTable;
  'cg.draft': DraftTable;
  'cg.otp_challenge': OtpChallengeTable;
  'cg.intake_session': IntakeSessionTable;
  'cg.message': MessageTable;
  'cg.abuse_signal': AbuseSignalTable;
  'cg.ai_use_register': AiUseRegisterTable;
  'cg.extraction': ExtractionTable;
}
