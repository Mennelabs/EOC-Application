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
  /** FLD-03: typed into the field app or carried by the QR at staging. */
  check_in_code: string | null;
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
  /** PER-02: hours per shift before an assignment warns (layer 4). */
  hours_limit: number | null;
  /** DSP-09: the agency when it runs its own tenant. */
  home_tenant_id: Uuid | null;
  /** FR-13.01: badge photo object key. */
  photo_key: string | null;
  archived_at: TsNullable;
  archived_reason: string | null;
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
/** What a reviewer must see about a filed report; set by the worker, never a decision (PHO-15, SEC-17). */
export interface ReportFlag {
  kind: 'possible_duplicate' | 'duplicate_photo' | 'verify_suggested' | 'ai_assisted';
  reason: string;
  reportId?: string;
  photoId?: string;
  at: string;
}

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
  after_enc: Buffer | null;
  after_merged_at: TsNullable;
  confirmation_texts: Generated<number>;
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
  address_key: string | null;
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
  flags: JsonGen<ReportFlag[]>;
  content_hash: Buffer | null;
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
  field_record_type:
    | 'field_assessment'
    | 'hazard'
    | 'mission'
    | 'need'
    | 'search_mark'
    | 'placard'
    | 'site'
    | 'pet_intake'
    | 'site_walkthrough'
    | 'debris_ticket'
    | 'inspection'
    | 'road_status'
    | 'canvass_visit'
    | 'pa_site'
    | null;
  field_record_id: Uuid | null;
}

export type NeedStatus = 'open' | 'claimed' | 'in_progress' | 'met' | 'closed' | 'withdrawn';

export interface NeedTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid | null;
  subject_party_id: Uuid | null;
  event_id: Uuid | null;
  category: string;
  detail: string | null;
  status: Generated<NeedStatus>;
  // Needs board (layer 3; CON-08, NED-02, NED-07)
  claimed_by_tenant_id: Uuid | null;
  claimed_by_account_id: Uuid | null;
  claimed_at: TsNullable;
  assigned_by_account_id: Uuid | null;
  released_at: TsNullable;
  done_at: TsNullable;
  done_note: string | null;
  source: Generated<'report' | 'standalone' | 'staff'>;
  location_id: Uuid | null;
  contact_party_id: Uuid | null;
  reference_code: string | null;
  execution_id: Uuid | null;
}

export type NeedEventKind =
  | 'created'
  | 'claimed'
  | 'assigned'
  | 'released'
  | 'done'
  | 'reopened'
  | 'overlap_warned'
  | 'exported'
  | 'withdrawn';

export interface NeedEventTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  need_id: Uuid;
  kind: NeedEventKind;
  actor_account_id: Uuid | null;
  actor_tenant_id: Uuid | null;
  note: string | null;
  detail: JsonGen<Record<string, unknown>>;
  created_at: TsGen;
}

export interface BoardVisibilityTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid | null;
  scope: 'role' | 'agency' | 'person';
  subject_key: string;
  sees: 'own' | 'consented' | 'all';
  reason: string;
}

/** Sharing with a partner organization: the only path a partner reads through (NED-04/05, AC-17C). */
export interface ShareGrantTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  to_tenant_id: Uuid;
  org_type: string;
  report_id: Uuid | null;
  need_id: Uuid | null;
  party_id: Uuid | null;
  consent_id: Uuid | null;
  agreement_id: Uuid | null;
  sections: Generated<string[]>;
  projection: JsonGen<Record<string, unknown>>;
  projection_enc: Buffer | null;
  granted_at: TsGen;
  revoked_at: TsNullable;
  revoke_reason: string | null;
  recall_notice_message_id: Uuid | null;
}

export interface ReferralTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  from_tenant_id: Uuid;
  to_tenant_id: Uuid | null;
  to_org_type: string | null;
  report_id: Uuid | null;
  need_id: Uuid | null;
  party_id: Uuid | null;
  share_grant_id: Uuid | null;
  purpose: string;
  status: Generated<'open' | 'accepted' | 'declined' | 'done'>;
  opened_by: Uuid;
  accepted_by: Uuid | null;
  closed_at: TsNullable;
  outcome: string | null;
  attempts: JsonGen<unknown[]>;
}

export interface PartnerContactTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  org_tenant_id: Uuid | null;
  agency: string;
  name_enc: Buffer;
  role: string | null;
  methods_enc: Buffer;
  type: Generated<'operations' | 'twenty_four_hour' | 'backup' | 'media' | 'liaison'>;
  active: Generated<boolean>;
  verified_at: TsNullable;
  verify_by: Date | string | null;
  backup_of: Uuid | null;
  owner_account_id: Uuid | null;
}

export type SiteKind =
  | 'shelter'
  | 'feeding'
  | 'pod'
  | 'marc'
  | 'cooling'
  | 'warming'
  | 'reporting'
  | 'charging'
  | 'other';
export type SiteStatus = 'planned' | 'open' | 'limited' | 'full' | 'closed';

export interface SiteTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid | null;
  kind: SiteKind;
  name: string;
  slug: string;
  location_id: Uuid | null;
  status: Generated<SiteStatus>;
  capacity: number | null;
  occupancy: number | null;
  hours: JsonGen<Record<string, unknown>>;
  services: Generated<string[]>;
  pets: Generated<'yes' | 'no' | 'service_animals' | 'unknown'>;
  accessibility: JsonGen<Record<string, unknown>>;
  medical_power: boolean | null;
  languages: Generated<string[]>;
  transit: string | null;
  directions: string | null;
  notes: string | null;
  confidential: Generated<boolean>;
  lead_contact_id: Uuid | null;
  confirm_every_hours: Generated<number>;
  last_confirmed_at: TsNullable;
  last_confirmed_by: Uuid | null;
  published_version: number | null;
  published_at: TsNullable;
  unpublished_at: TsNullable;
  usng: string | null;
  /** CON-16: the partner organization that runs the site. */
  operator_tenant_id: Uuid | null;
  posted_by_tenant_id: Uuid | null;
}

export interface ZipCentroidTable {
  tenant_id: Uuid;
  postal: string;
  name: string | null;
  geom: unknown;
}

export interface ResourceTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  slug: string;
  type: 'hotline' | 'program' | 'deadline' | 'guidance' | 'link' | 'document';
  category: Generated<string>;
  ordering: Generated<number>;
  owner_account_id: Uuid | null;
  status: Generated<'draft' | 'published' | 'expired' | 'removed'>;
  review_at: Date | string | null;
  expires_at: TsNullable;
  reference_url: string | null;
  link_status: Generated<'unchecked' | 'ok' | 'broken'>;
  link_checked_at: TsNullable;
  targeting: JsonGen<Record<string, unknown>>;
  published_version: number | null;
  published_at: TsNullable;
  unpublished_at: TsNullable;
}

export interface ResourceTextTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  resource_id: Uuid;
  locale: string;
  title: string;
  summary: string | null;
  body_html: Generated<string>;
  human_reviewed_by: Uuid | null;
  reviewed_at: TsNullable;
}

export type NoticeKind =
  | 'site_reconfirm'
  | 'site_hidden'
  | 'resource_review'
  | 'resource_link'
  | 'resource_expired'
  | 'contact_reverify'
  | 'publication'
  | 'publication_withdrawn'
  | 'ai_health';

/** Layer 3's send-once ledger (notices and reminders sent): one row per subject and cycle (BRD:FR-00.06). */
export interface NoticeLogTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  kind: NoticeKind;
  subject_kind:
    'site' | 'resource' | 'partner_contact' | 'publication' | 'tenant' | 'ai_health_alert';
  subject_id: Uuid;
  cycle_key: string;
  due_at: ColumnType<Date, Date | string, Date | string>;
  state: Generated<'active' | 'sent' | 'completed' | 'canceled'>;
  owner_account_id: Uuid | null;
  sent_at: TsNullable;
  recipient_count: Generated<number>;
  completed_at: TsNullable;
  created_at: TsGen;
}

// Layer 4 (plan §2, task A): the field roster.

export type CredentialKind =
  | 'damage_assessor'
  | 'chainsaw'
  | 'spanish_speaker'
  | 'chaplain'
  | 'ham_operator'
  | 'medical'
  | 'cert'
  | 'driver_cdl'
  | 'heavy_equipment'
  | 'shelter_management'
  | 'food_safety'
  | 'child_safeguarding'
  | 'mental_health_first_aid'
  | 'background_check'
  | 'other';

/** PER-01, FR-05.06: a recorded skill or certification; never inferred. */
export interface CredentialTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  personnel_id: Uuid;
  kind: CredentialKind;
  label: string | null;
  issuer: string | null;
  issued_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  status: Generated<'recorded' | 'verified' | 'expired' | 'revoked'>;
  verified_by: Uuid | null;
  verified_at: TsNullable;
  evidence_key: string | null;
  note: string | null;
}

export type TeamKind = 'team' | 'unit' | 'canteen' | 'crew' | 'strike_team' | 'net';
export type TeamStatus =
  'available' | 'en_route' | 'on_task' | 'break' | 'out_of_service' | 'overdue';

/** DSP-02, FR-06.08: a team or unit with its agency, skills and equipment. */
export interface TeamTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid | null;
  key: string;
  name: string;
  kind: Generated<TeamKind>;
  agency_tenant_id: Uuid | null;
  agency: string | null;
  callsign: string | null;
  lead_personnel_id: Uuid | null;
  skills: Generated<string[]>;
  equipment: Generated<string[]>;
  capacity: number | null;
  check_in_interval_minutes: Generated<number>;
  status: Generated<'active' | 'stood_down' | 'archived'>;
  notes: string | null;
}

export interface TeamMemberTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  team_id: Uuid;
  personnel_id: Uuid;
  role: Generated<'lead' | 'member' | 'driver' | 'operator' | 'medic'>;
  joined_at: TsGen;
  left_at: TsNullable;
  left_reason: string | null;
  created_by: Uuid | null;
}

/** DSP-01, DSP-05, RULE-03: confirmed and suggested status kept apart. */
export interface TeamStatusTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  team_id: Uuid;
  status: TeamStatus;
  fact: Generated<'confirmed' | 'suggested'>;
  source: 'app' | 'console' | 'net_control' | 'timer' | 'location' | 'seed';
  set_by_account_id: Uuid | null;
  check_in_id: Uuid | null;
  note: string | null;
  detail: JsonGen<Record<string, unknown>>;
  created_at: TsGen;
}

/** FLD-02: a registered app install; wipe touches only the app's data. */
export interface FieldDeviceTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  account_id: Uuid;
  install_id: string;
  platform: 'ios' | 'android' | 'web';
  managed: Generated<boolean>;
  model: string | null;
  app_version: string | null;
  status: Generated<'active' | 'wipe_requested' | 'wiped' | 'revoked'>;
  registered_at: TsGen;
  last_contact_at: TsNullable;
  wipe_requested_at: TsNullable;
  wipe_requested_by: Uuid | null;
  wipe_reason: string | null;
  wipe_confirmed_at: TsNullable;
}

/** FLD-03, FL-17: a shift, with the credentials in force when it started. */
export interface CheckInTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  personnel_id: Uuid;
  event_id: Uuid;
  team_id: Uuid | null;
  agency_tenant_id: Uuid | null;
  method: 'qr' | 'event_code' | 'net_control' | 'console';
  credentials_snapshot: JsonGen<unknown[]>;
  device_id: Uuid | null;
  location_sharing: Generated<boolean>;
  started_at: TsGen;
  ended_at: TsNullable;
  ended_by: Uuid | null;
  end_reason: 'checked_out' | 'shift_end' | 'coordinator' | 'timeout' | 'wipe' | null;
  /** Computed by the database from started_at and ended_at. */
  hours: ColumnType<string | null, never, never>;
  created_by: Uuid | null;
}

/** DSP-08: the live trail, in daily partitions dropped after the tenant's period. */
export interface PositionTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  check_in_id: Uuid;
  personnel_id: Uuid;
  team_id: Uuid | null;
  geom: ColumnType<unknown, unknown, unknown>;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading: number | null;
  source: 'app' | 'net_control' | 'manual' | 'help_alert';
  recorded_at: Ts;
  received_at: TsGen;
}

export type ParcelStructure =
  | 'single_family'
  | 'manufactured'
  | 'apartment_building'
  | 'commercial'
  | 'public'
  | 'vacant'
  | 'other';

/** FLD-04: tenant parcel data the field app snaps a pin to. */
export interface ParcelTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  parcel_id: string;
  geom: ColumnType<unknown, unknown, unknown>;
  /** Computed by the database from geom. */
  centroid: ColumnType<unknown, never, never>;
  line1: string | null;
  city: string | null;
  postal: string | null;
  structure: Generated<ParcelStructure>;
  unit_count: number | null;
  area_key: string | null;
  source: Generated<string>;
  loaded_at: TsGen;
}

// Layer 4 task B: missions, assignments, hazards, messages, safety, logs, reminders (F09),
// badges, field records and sync. Generated from the DDL of migrations 0030–0034.

export interface MissionCounterTable {
  tenant_id: Generated<Uuid>;
  next_value: Generated<number>;
}

export interface MissionTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  reference: string;
  kind:
    | 'welfare_check'
    | 'verification_route'
    | 'cleanup_work_order'
    | 'delivery'
    | 'outreach_sweep'
    | 'site_staffing'
    | 'search'
    | 'road_clearance'
    | 'traffic_control'
    | 'debris'
    | 'other';
  subcategory: string | null;
  state: Generated<'draft' | 'open' | 'en_route' | 'on_scene' | 'cleared' | 'closed' | 'canceled'>;
  priority: Generated<'low' | 'normal' | 'high' | 'urgent'>;
  urgency: Generated<'routine' | 'soon' | 'now'>;
  source: 'need' | 'report' | 'call' | 'walk_in' | 'field' | 'staff' | 'board';
  summary: string | null;
  conditions: string | null;
  caller_enc: Buffer | null;
  /** SEC-12: opaque pointer to the CJIS enclave record (migration 0041). */
  cji_ref: string | null;
  cji_linked_at: TsNullable;
  cji_linked_by: Uuid | null;
  caller_language: string | null;
  interpreter_needed: Generated<boolean>;
  location_id: Uuid | null;
  location_state: Generated<'verified' | 'approximate' | 'manual' | 'unknown'>;
  need_id: Uuid | null;
  report_id: Uuid | null;
  site_id: Uuid | null;
  route: JsonValue | null;
  owning_tenant_id: Uuid | null;
  required_credentials: Generated<string[]>;
  lock_by: Uuid | null;
  lock_at: TsNullable;
  lock_reason: string | null;
  disposition:
    | 'completed'
    | 'referred'
    | 'no_action_needed'
    | 'unable_to_locate'
    | 'canceled'
    | 'duplicate'
    | 'transferred'
    | 'other'
    | null;
  disposition_note: string | null;
  case_reference: string | null;
  report_required: Generated<boolean>;
  report_generated: Generated<boolean>;
  reviewed_by: Uuid | null;
  reviewed_at: TsNullable;
  opened_at: TsNullable;
  cleared_at: TsNullable;
  closed_at: TsNullable;
  closed_reason: string | null;
  reopened_count: Generated<number>;
  execution_id: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface MissionEventTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  mission_id: Uuid;
  kind:
    | 'created'
    | 'updated'
    | 'state_changed'
    | 'priority_changed'
    | 'locked'
    | 'unlocked'
    | 'narrative'
    | 'amendment'
    | 'disposition'
    | 'person_added'
    | 'person_updated'
    | 'person_removed'
    | 'media_added'
    | 'media_removed'
    | 'assignment'
    | 'reopened'
    | 'canceled'
    | 'hazard'
    | 'reminder';
  narrative_role:
    'call_taker' | 'dispatcher' | 'responder' | 'supervisor' | 'follow_up' | 'system' | null;
  from_state: string | null;
  to_state: string | null;
  actor_account_id: Uuid | null;
  actor_personnel_id: Uuid | null;
  reason: string | null;
  body: string | null;
  amends_event_id: Uuid | null;
  detail: JsonGen<Record<string, unknown>>;
  client_command_id: Uuid | null;
  occurred_at: TsGen;
  created_at: TsGen;
}

export interface MissionPersonTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  mission_id: Uuid;
  role:
    | 'survivor'
    | 'reporting_party'
    | 'witness'
    | 'subject'
    | 'victim'
    | 'caregiver'
    | 'property_owner'
    | 'other';
  display_label: string | null;
  details_enc: Buffer | null;
  injury: 'none' | 'minor' | 'serious' | 'critical' | 'deceased' | 'unknown' | null;
  injury_detail_enc: Buffer | null;
  transport: 'none' | 'ems' | 'own' | 'shelter_transport' | 'other' | 'unknown' | null;
  transport_destination: string | null;
  transport_started_at: TsNullable;
  transport_ended_at: TsNullable;
  behavioral_health_enc: Buffer | null;
  party_id: Uuid | null;
  status: Generated<'active' | 'removed'>;
  removed_reason: string | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface MissionMediaTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  mission_id: Uuid;
  kind: 'photo' | 'document' | 'audio' | 'video' | 'bodycam_reference' | 'live_feed_reference';
  photo_id: Uuid | null;
  object_key: string | null;
  original_name: string | null;
  content_type: string | null;
  bytes: number | null;
  sha256: Buffer | null;
  description: string | null;
  source: Generated<'field' | 'console' | 'resident' | 'partner' | 'external'>;
  access_class: Generated<'internal' | 'restricted'>;
  retention_category: Generated<string>;
  uploaded_by: Uuid | null;
  uploaded_at: TsGen;
  removed_at: TsNullable;
  removed_by: Uuid | null;
  removed_reason: string | null;
  created_at: TsGen;
}

export interface AssignmentTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  mission_id: Uuid;
  resource_kind: 'person' | 'team';
  personnel_id: Uuid | null;
  team_id: Uuid | null;
  state: Generated<
    | 'assigned'
    | 'dispatched'
    | 'acknowledged'
    | 'declined'
    | 'en_route'
    | 'on_scene'
    | 'cleared'
    | 'released'
  >;
  assigned_at: TsGen;
  assigned_by: Uuid | null;
  suggested: Generated<boolean>;
  suggestion_reasons: Generated<string[]>;
  conflicts: JsonGen<Record<string, unknown>>;
  override_reason: string | null;
  override_by: Uuid | null;
  dispatched_at: TsNullable;
  dispatched_by: Uuid | null;
  dispatch_method: 'app' | 'text' | 'radio' | 'phone' | 'in_person' | null;
  delivered_at: TsNullable;
  delivery_evidence: JsonValue | null;
  acknowledged_at: TsNullable;
  acknowledged_by: Uuid | null;
  declined_at: TsNullable;
  declined_reason: string | null;
  en_route_at: TsNullable;
  on_scene_at: TsNullable;
  on_scene_confirmed_by: Uuid | null;
  cleared_at: TsNullable;
  released_at: TsNullable;
  released_by: Uuid | null;
  release_reason: string | null;
  execution_id: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface AssignmentEventTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  assignment_id: Uuid;
  kind:
    | 'assigned'
    | 'dispatched'
    | 'delivered'
    | 'acknowledged'
    | 'declined'
    | 'en_route'
    | 'on_scene'
    | 'cleared'
    | 'released'
    | 'reopened'
    | 'override'
    | 'suggested_status';
  from_state: string | null;
  to_state: string | null;
  actor_account_id: Uuid | null;
  actor_personnel_id: Uuid | null;
  method: string | null;
  evidence: JsonValue | null;
  reason: string | null;
  client_command_id: Uuid | null;
  occurred_at: TsGen;
  created_at: TsGen;
}

export interface HazardTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  mission_id: Uuid | null;
  kind:
    | 'downed_line'
    | 'gas_leak'
    | 'blocked_road'
    | 'unsafe_structure'
    | 'flooding'
    | 'debris'
    | 'weapons'
    | 'hazmat'
    | 'medical_emergency'
    | 'mental_health_crisis'
    | 'violence'
    | 'child_or_elder_involved'
    | 'language_barrier'
    | 'utility_risk'
    | 'weather'
    | 'public_health'
    | 'animal'
    | 'missing_person_concern'
    | 'other';
  state: Generated<'reported' | 'confirmed' | 'corrected' | 'cleared'>;
  severity: Generated<'info' | 'caution' | 'danger' | 'critical'>;
  summary: string | null;
  restricted: Generated<boolean>;
  details_enc: Buffer | null;
  geom: ColumnType<unknown, unknown, unknown> | null;
  radius_m: number | null;
  location_id: Uuid | null;
  source: 'field' | 'console' | 'call' | 'net_control' | 'resident_report' | 'ai_suggested';
  ai_suggested: Generated<boolean>;
  accepted_by: Uuid | null;
  accepted_at: TsNullable;
  reported_by: Uuid | null;
  reported_personnel_id: Uuid | null;
  reported_at: TsGen;
  confirmed_at: TsNullable;
  confirmed_by: Uuid | null;
  cleared_at: TsNullable;
  cleared_by: Uuid | null;
  cleared_reason: string | null;
  photo_id: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface HazardEventTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  hazard_id: Uuid;
  kind: 'reported' | 'confirmed' | 'corrected' | 'cleared' | 'accepted' | 'reopened' | 'warned';
  from_state: string | null;
  to_state: string | null;
  actor_account_id: Uuid | null;
  actor_personnel_id: Uuid | null;
  reason: string | null;
  detail: JsonGen<Record<string, unknown>>;
  occurred_at: TsGen;
  created_at: TsGen;
}

export interface FieldMessageTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  kind: Generated<
    'message' | 'assignment_notice' | 'safety_warning' | 'hazard_warning' | 'broadcast' | 'timer'
  >;
  template: string | null;
  body: string;
  lang: Generated<string>;
  priority: Generated<'normal' | 'high' | 'urgent'>;
  audience_kind: 'person' | 'team' | 'agency' | 'area' | 'event';
  audience_personnel_id: Uuid | null;
  audience_team_id: Uuid | null;
  audience_tenant_id: Uuid | null;
  audience_geom: ColumnType<unknown, unknown, unknown> | null;
  mission_id: Uuid | null;
  hazard_id: Uuid | null;
  requires_ack: Generated<boolean>;
  sent_by: Uuid | null;
  sent_at: TsGen;
  expires_at: TsNullable;
  recipient_count: Generated<number>;
  created_at: TsGen;
}

export interface FieldMessageReceiptTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  message_id: Uuid;
  personnel_id: Uuid;
  account_id: Uuid | null;
  device_id: Uuid | null;
  channel: Generated<'app' | 'sms' | 'radio' | 'in_person'>;
  sms_message_id: Uuid | null;
  delivered_at: TsNullable;
  read_at: TsNullable;
  acknowledged_at: TsNullable;
  created_at: TsGen;
}

export interface SafetyAlertTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  kind:
    | 'help_button'
    | 'missed_check_in'
    | 'unacknowledged_assignment'
    | 'hazard_entry'
    | 'device_lost';
  personnel_id: Uuid | null;
  team_id: Uuid | null;
  check_in_id: Uuid | null;
  assignment_id: Uuid | null;
  hazard_id: Uuid | null;
  geom: ColumnType<unknown, unknown, unknown> | null;
  accuracy_m: number | null;
  position_at: TsNullable;
  note: string | null;
  state: Generated<'open' | 'acknowledged' | 'escalated' | 'resolved' | 'false_alarm'>;
  raised_at: TsGen;
  raised_by: Uuid | null;
  client_uuid: Uuid | null;
  acknowledged_at: TsNullable;
  acknowledged_by: Uuid | null;
  escalated_at: TsNullable;
  escalated_to_role: string | null;
  resolved_at: TsNullable;
  resolved_by: Uuid | null;
  resolution: string | null;
  detail: JsonGen<Record<string, unknown>>;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface CommsLogTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  net: string;
  entry_at: TsGen;
  from_station: string | null;
  to_station: string | null;
  team_id: Uuid | null;
  kind:
    | 'status_heard'
    | 'position_heard'
    | 'message'
    | 'check_in'
    | 'check_out'
    | 'traffic'
    | 'net_open'
    | 'net_close';
  message: string | null;
  operator_account_id: Uuid | null;
  team_status_id: Uuid | null;
  position_id: Uuid | null;
  position_recorded_at: TsNullable;
  check_in_id: Uuid | null;
  created_at: TsGen;
}

export interface ActivityEntryTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  personnel_id: Uuid | null;
  team_id: Uuid | null;
  occurred_at: TsGen;
  kind:
    | 'check_in'
    | 'check_out'
    | 'assigned'
    | 'dispatched'
    | 'acknowledged'
    | 'en_route'
    | 'on_scene'
    | 'cleared'
    | 'released'
    | 'status'
    | 'message'
    | 'alert'
    | 'service'
    | 'hazard'
    | 'note'
    | 'assessment';
  summary: string;
  ref_kind: string | null;
  ref_id: Uuid | null;
  actor_account_id: Uuid | null;
  created_at: TsGen;
}

export interface SignificantEventTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  occurred_at: TsGen;
  kind:
    | 'mission_opened'
    | 'mission_closed'
    | 'mission_priority'
    | 'dispatch'
    | 'arrival'
    | 'hazard'
    | 'safety_alert'
    | 'site'
    | 'message'
    | 'check_in'
    | 'briefing'
    | 'note';
  summary: string;
  mission_id: Uuid | null;
  team_id: Uuid | null;
  ref_kind: string | null;
  ref_id: Uuid | null;
  actor_account_id: Uuid | null;
  created_at: TsGen;
}

export interface ReminderTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid | null;
  kind:
    | 'call_back'
    | 'site_reconfirm'
    | 'renew_agreement'
    | 'revisit'
    | 'follow_up'
    | 'check_in_timer'
    | 'custom';
  title: string;
  note: string | null;
  owner_account_id: Uuid | null;
  owner_team_id: Uuid | null;
  mission_id: Uuid | null;
  subject_kind: string | null;
  subject_id: Uuid | null;
  due_at: Ts;
  recurrence: 'daily' | 'weekly' | null;
  recurrence_approved_by: Uuid | null;
  state: Generated<'active' | 'overdue' | 'acknowledged' | 'completed' | 'canceled'>;
  snoozed_until: TsNullable;
  acknowledged_at: TsNullable;
  acknowledged_by: Uuid | null;
  completed_at: TsNullable;
  completed_by: Uuid | null;
  completion_ref_kind: string | null;
  completion_ref_id: Uuid | null;
  canceled_at: TsNullable;
  canceled_by: Uuid | null;
  cancel_reason: string | null;
  escalate_to_role: string | null;
  escalate_after_minutes: number | null;
  escalated_at: TsNullable;
  quiet_from: string | null;
  quiet_to: string | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface ReminderEventTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  reminder_id: Uuid;
  kind:
    | 'created'
    | 'snoozed'
    | 'reset'
    | 'acknowledged'
    | 'completed'
    | 'canceled'
    | 'overdue'
    | 'escalated'
    | 'recurred';
  actor_account_id: Uuid | null;
  detail: JsonGen<Record<string, unknown>>;
  occurred_at: TsGen;
  created_at: TsGen;
}

export interface BadgeTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  personnel_id: Uuid;
  event_id: Uuid | null;
  template: Generated<string>;
  display_name: string;
  agency: string | null;
  role_label: string | null;
  access_label: string | null;
  photo_key: string | null;
  credentials_snapshot: JsonGen<Record<string, unknown>>;
  valid_from: TsGen;
  valid_to: Ts;
  state: Generated<
    | 'generated'
    | 'print_requested'
    | 'print_confirmed'
    | 'print_failed'
    | 'handed_out'
    | 'revoked'
    | 'expired'
    | 'replaced'
  >;
  code_hash: Buffer;
  replaces_badge_id: Uuid | null;
  print_requested_at: TsNullable;
  print_confirmed_at: TsNullable;
  print_confirmed_by: Uuid | null;
  print_failed_reason: string | null;
  handed_out_at: TsNullable;
  revoked_at: TsNullable;
  revoked_by: Uuid | null;
  revoke_reason: string | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface BadgeEventTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  badge_id: Uuid;
  kind:
    | 'generated'
    | 'print_requested'
    | 'print_confirmed'
    | 'print_failed'
    | 'handed_out'
    | 'revoked'
    | 'expired'
    | 'replaced'
    | 'verified';
  actor_account_id: Uuid | null;
  detail: JsonGen<Record<string, unknown>>;
  occurred_at: TsGen;
  created_at: TsGen;
}

export interface ServiceLogTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  client_uuid: Uuid;
  kind:
    | 'meal'
    | 'water_case'
    | 'tarp'
    | 'voucher'
    | 'cot'
    | 'ride'
    | 'car_served'
    | 'person_served'
    | 'supplies_per_car'
    | 'pet_food'
    | 'other';
  count: Generated<number>;
  site_id: Uuid | null;
  mission_id: Uuid | null;
  team_id: Uuid | null;
  personnel_id: Uuid | null;
  note: string | null;
  occurred_at: TsGen;
  created_by: Uuid | null;
  created_at: TsGen;
}

export interface StockMovementTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  stock_item_id: Uuid;
  kind: 'received' | 'issued' | 'counted' | 'transferred' | 'adjusted' | 'requested';
  quantity: string;
  to_site_id: Uuid | null;
  mission_id: Uuid | null;
  client_uuid: Uuid;
  occurred_at: TsGen;
  actor_account_id: Uuid | null;
  note: string | null;
  created_at: TsGen;
}

export interface ShelterIncidentTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  site_id: Uuid;
  occurred_at: TsGen;
  kind: 'medical' | 'behavioral' | 'safety' | 'security' | 'facility' | 'other';
  summary_enc: Buffer;
  reported_by: Uuid | null;
  client_uuid: Uuid | null;
  created_at: TsGen;
}

export interface JobAidTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  key: string;
  role_key: string | null;
  lang: Generated<string>;
  kind: 'checklist' | 'matrix' | 'standard' | 'briefing' | 'guidance';
  title: string;
  body_html: string;
  status: Generated<'draft' | 'exercise_draft' | 'approved' | 'retired'>;
  approved_by: Uuid | null;
  approved_at: TsNullable;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface SearchMarkTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  mission_id: Uuid | null;
  location_id: Uuid | null;
  parcel_id: string | null;
  team_id: Uuid | null;
  personnel_id: Uuid | null;
  searched_at: TsGen;
  entry_type: Generated<'primary' | 'secondary' | 'exterior_only'>;
  occupants_found: Generated<number>;
  occupants_removed: Generated<number>;
  victims_count: Generated<number>;
  hazards: Generated<string[]>;
  mark_code: string | null;
  note: string | null;
  photo_id: Uuid | null;
  usng: string | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface PlacardTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  location_id: Uuid | null;
  parcel_id: string | null;
  report_id: Uuid | null;
  kind: 'inspected' | 'restricted_use' | 'unsafe';
  posted_at: TsGen;
  inspector_personnel_id: Uuid | null;
  photo_id: Uuid | null;
  note: string | null;
  resident_message_id: Uuid | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface RoadStatusTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  name: string;
  geom: ColumnType<unknown, unknown, unknown> | null;
  status: 'open' | 'closed' | 'one_lane' | 'impassable' | 'cleared';
  reason: string | null;
  reported_by: Uuid | null;
  reported_personnel_id: Uuid | null;
  reported_at: TsGen;
  cleared_at: TsNullable;
  exported_at: TsNullable;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface DebrisTicketTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  ticket_number: string;
  load_location_id: Uuid | null;
  disposal_site: string | null;
  truck_id: string | null;
  truck_capacity_cy: string | null;
  load_percent: number | null;
  cubic_yards: string | null;
  debris_type:
    'vegetative' | 'construction' | 'mixed' | 'white_goods' | 'hazardous' | 'electronic' | 'other';
  loaded_at: TsGen;
  unloaded_at: TsNullable;
  monitor_personnel_id: Uuid | null;
  photo_id: Uuid | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface InspectionTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  site_id: Uuid | null;
  kind: 'shelter' | 'feeding_site' | 'pod' | 'warehouse' | 'other';
  checklist: JsonGen<Record<string, unknown>>;
  result: Generated<'pass' | 'corrective' | 'fail'>;
  illness_count: number | null;
  inspector_personnel_id: Uuid | null;
  inspected_at: TsGen;
  note: string | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface PetIntakeTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  site_id: Uuid | null;
  owner_reference_code: string | null;
  species: string;
  description: string | null;
  photo_id: Uuid | null;
  status: Generated<
    'sheltered' | 'reunited' | 'transferred' | 'lost_report' | 'found_report' | 'deceased'
  >;
  intake_at: TsGen;
  released_at: TsNullable;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface SiteWalkthroughTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  site_id: Uuid;
  phase: 'before' | 'after';
  walked_at: TsGen;
  photo_ids: Generated<string[]>;
  key_holders: string | null;
  issues: string | null;
  personnel_id: Uuid | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface RightOfEntryTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  mission_id: Uuid | null;
  need_id: Uuid | null;
  report_id: Uuid | null;
  location_id: Uuid | null;
  signer_role: 'owner' | 'landlord' | 'tenant' | 'agent';
  signer_name_enc: Buffer | null;
  signature_key: string | null;
  scope: string;
  landlord_consent: Generated<boolean>;
  signed_at: TsGen;
  release_signed_at: TsNullable;
  release_signature_key: string | null;
  witness_personnel_id: Uuid | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface VolunteerRegistrationTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  personnel_id: Uuid;
  waiver_signed_at: TsNullable;
  waiver_version: string | null;
  skills: Generated<string[]>;
  background_check_status: Generated<
    'not_required' | 'pending' | 'cleared' | 'not_cleared' | 'expired'
  >;
  background_check_checked_at: TsNullable;
  assigned_team_id: Uuid | null;
  badge_id: Uuid | null;
  registered_by: Uuid | null;
  registered_at: TsGen;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface StockItemTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  site_id: Uuid;
  sku: string;
  name: string;
  unit: Generated<string>;
  quantity: Generated<string>;
  barcode: string | null;
  photo_id: Uuid | null;
  reorder_at: string | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface InterpreterRequestTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  language: string;
  mode: Generated<'in_person' | 'phone' | 'video'>;
  site_id: Uuid | null;
  mission_id: Uuid | null;
  requested_by: Uuid | null;
  requested_personnel_id: Uuid | null;
  requested_at: TsGen;
  state: Generated<'open' | 'accepted' | 'in_progress' | 'done' | 'canceled'>;
  interpreter_personnel_id: Uuid | null;
  accepted_at: TsNullable;
  done_at: TsNullable;
  minutes: number | null;
  note: string | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface ChildCheckInTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  site_id: Uuid;
  child_enc: Buffer;
  age_band: '0-2' | '3-5' | '6-9' | '10-13' | '14-17';
  guardian_enc: Buffer;
  pickup_code_hash: Buffer;
  needs_enc: Buffer | null;
  checked_in_at: TsGen;
  checked_out_at: TsNullable;
  checked_out_to_enc: Buffer | null;
  staff_personnel_id: Uuid | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface CanvassVisitTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  mission_id: Uuid | null;
  location_id: Uuid | null;
  parcel_id: string | null;
  team_id: Uuid | null;
  personnel_id: Uuid | null;
  outcome:
    | 'spoke_with_resident'
    | 'assisted_report'
    | 'no_one_home'
    | 'refused'
    | 'vacant'
    | 'unsafe'
    | 'referred';
  report_id: Uuid | null;
  door_hanger_left: Generated<boolean>;
  language: string | null;
  revisit_at: TsNullable;
  reminder_id: Uuid | null;
  visited_at: TsGen;
  note: string | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface ShelterStayTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  site_id: Uuid;
  event_id: Uuid;
  household_party_id: Uuid | null;
  household_enc: Buffer | null;
  wristband_code_hash: Buffer | null;
  household_size: Generated<number>;
  adults: Generated<number>;
  children: Generated<number>;
  cots: Generated<string[]>;
  dietary_needs: string | null;
  access_needs_enc: Buffer | null;
  pets: Generated<number>;
  language: string | null;
  checked_in_at: TsGen;
  checked_out_at: TsNullable;
  checked_out_reason: string | null;
  registered_by: Uuid | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface HealthNoteTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  site_id: Uuid | null;
  shelter_stay_id: Uuid | null;
  subject_party_id: Uuid | null;
  kind: 'medication_request' | 'equipment_replacement' | 'assessment' | 'follow_up' | 'other';
  note_enc: Buffer;
  request_status: 'open' | 'ordered' | 'delivered' | 'closed' | null;
  author_personnel_id: Uuid | null;
  client_uuid: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

/** FLD-08/10/13: what a field team saw at a property (migration 0037). */
export interface FieldAssessmentTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  client_uuid: Uuid;
  mission_id: Uuid | null;
  assignment_id: Uuid | null;
  team_id: Uuid | null;
  personnel_id: Uuid | null;
  mode: Generated<'sweep' | 'detailed' | 'validation'>;
  parcel_id: string | null;
  location_id: Uuid | null;
  geom: ColumnType<unknown, unknown, unknown> | null;
  accuracy_m: number | null;
  usng: string | null;
  landmark: string | null;
  structure: Generated<
    'single_family' | 'manufactured' | 'apartment_building' | 'commercial' | 'public' | 'other'
  >;
  degree: FemaDegree | 'cant_reach';
  observations: JsonGen<Record<string, unknown>>;
  note: string | null;
  report_id: Uuid | null;
  duplicate_of: Uuid | null;
  review_state: Generated<'new' | 'accepted' | 'rejected' | 'superseded'>;
  reviewed_by: Uuid | null;
  reviewed_at: TsNullable;
  review_reason: string | null;
  assessed_at: TsGen;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface ChangeFeedTable {
  seq: Generated<number>;
  tenant_id: Uuid;
  scope_kind: 'person' | 'team' | 'area' | 'event' | 'tenant';
  scope_id: Uuid | null;
  record_type: string;
  record_id: Uuid;
  record_version: number | null;
  op: 'upsert' | 'delete';
  created_at: TsGen;
}

export interface ClientCommandTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  device_id: Uuid | null;
  account_id: Uuid | null;
  personnel_id: Uuid | null;
  kind: string;
  payload: JsonGen<Record<string, unknown>>;
  client_at: TsNullable;
  received_at: TsGen;
  applied_at: TsNullable;
  result: Generated<'received' | 'applied' | 'duplicate' | 'conflict' | 'rejected'>;
  result_detail: JsonGen<Record<string, unknown>>;
  record_type: string | null;
  record_id: Uuid | null;
  record_version: number | null;
  created_at: TsGen;
}

export interface PublicationTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  subject_kind: 'site' | 'resource' | 'alert_draft' | 'poster' | 'media_sheet';
  subject_id: Uuid;
  subject_version: number;
  snapshot: JsonValue;
  approved_by: Uuid;
  approved_at: TsGen;
  channels: Generated<string[]>;
  reason: string;
  unpublished_at: TsNullable;
  unpublished_by: Uuid | null;
  created_at: TsGen;
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
  /** Outbound to the resident, or the resident's reply (FL-11). */
  direction: Generated<'outbound' | 'inbound'>;
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

/** One verified toll-free number per county (docs/06); inbound webhooks resolve the tenant by it. */
export interface ChannelNumberTable extends Stamped {
  tenant_id: Uuid;
  number: string;
  capabilities: Generated<string[]>;
  provider: Generated<'twilio' | 'simulator'>;
  label: string | null;
  verified_at: TsNullable;
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

// Layer 6 task A (migration 0042): reference data snapshots and their rows (ADR-0039).

export type ReferenceDataset =
  | 'tract'
  | 'tract_profile'
  | 'structure'
  | 'flood_zone'
  | 'facility'
  | 'declaration'
  | 'nfip_summary'
  | 'risk'
  | 'alert'
  | 'power_outage';

/** Partner counts category (2026-10-15, DCL:DEC-09). */
export type PartnerCategory = 'needs_met' | 'services' | 'sheltered' | 'teams' | 'donated';

/** Which partner counts roll up: all, or the chosen organizations and categories. */
export type PartnerRollup =
  { all: true } | { all: false; partners: Uuid[]; categories: PartnerCategory[] };

/** One command a person asked for (ADR-0044, CMD-37); never the typed words. */
export interface CommandExecutionTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  account_id: Uuid;
  execution_id: Uuid;
  input_kind: 'shorthand' | 'natural' | 'alias';
  command: string;
  command_version: number;
  phase: number;
  plan: JsonGen<Record<string, unknown>>;
  plan_hash: string;
  confirmation: 'none' | 'one_tap' | 'full_review' | 'second_person';
  reversal: 'undo_15_min' | 'compensating' | 'none';
  state: 'awaiting_confirmation' | 'executing' | 'succeeded' | 'failed' | 'canceled' | 'stale';
  confirmed_by: Uuid | null;
  confirmed_at: TsNullable;
  reason: string | null;
  result: ColumnType<unknown, string | null | undefined, string | null>;
  reversal_of: Uuid | null;
  undone_by: Uuid | null;
  undo_until: TsNullable;
}

/** One AI call (AIG-01, layer-7 task A); never the prompt or the reply. */
export interface AiOutputTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  feature: string;
  provider: string;
  model: string;
  template_version: string | null;
  language: string | null;
  outcome: 'ok' | 'filtered' | 'invalid' | 'refused' | 'timeout' | 'error';
  latency_ms: number;
  execution_id: Uuid | null;
  target_type: string | null;
  target_id: Uuid | null;
  human_action: 'accepted' | 'edited' | 'rejected' | null;
  acted_by: Uuid | null;
  acted_at: TsNullable;
  created_at: Generated<Date>;
}

/** A feature people correct too often, or whose calls fail too often (AIG-09 as decided 2026-10-15). */
export interface AiHealthAlertTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  feature: string;
  language: Generated<string>;
  kind: 'corrections' | 'failures';
  window_size: number;
  counted: number;
  flagged: number;
  rate: ColumnType<string, number | string, number | string>;
  threshold: ColumnType<string, number | string, number | string>;
  raised_at: Generated<Date>;
  acknowledged_by: Uuid | null;
  acknowledged_at: TsNullable;
  cleared_at: TsNullable;
}

export interface DeclarationTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  incident_type: string | null;
  incident_start: ColumnType<string | null, string | null | undefined, string | null>;
  incident_end: ColumnType<string | null, string | null | undefined, string | null>;
  requested_areas: JsonGen<{ name: string; tenantId?: string; programs: string[] }[]>;
  box8_draft: string | null;
  box9_draft: string | null;
  review_label: Generated<string>;
  partner_rollup: JsonGen<PartnerRollup>;
}

export type OutageKind =
  | 'hospital'
  | 'water'
  | 'wastewater'
  | 'police'
  | 'fire_ems'
  | 'school'
  | 'child_care'
  | 'eldercare'
  | 'roads'
  | 'power';

export interface OutageTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  client_uuid: Uuid;
  kind: OutageKind;
  facility_source_id: string | null;
  facility_name: string | null;
  description: string | null;
  area: string | null;
  customers_out: number | null;
  started_at: ColumnType<Date, Date | string, Date | string>;
  expected_restoration_at: TsNullable;
  restored_at: TsNullable;
  source: Generated<'staff' | 'feed_suggestion' | 'utility_report'>;
  confirmed_by: Uuid | null;
  confirmed_at: TsNullable;
}

export interface CasualtyCountTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  kind: 'injured' | 'missing' | 'deceased';
  count: number;
  official_source: string;
  as_of: ColumnType<Date, Date | string, Date | string>;
  note: string | null;
  entered_by: Uuid;
  created_at: TsGen;
}

export interface PaSiteTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  client_uuid: Uuid;
  applicant: string;
  applicant_tenant_id: Uuid | null;
  name: string;
  description: string | null;
  category: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  geom: ColumnType<unknown, unknown, unknown> | null;
  estimated_cost: ColumnType<string | null, number | string | null, number | string | null>;
  cost_basis: Generated<'estimate' | 'verified'>;
  percent_complete: number | null;
  insured: Generated<'yes' | 'no' | 'unknown'>;
  other_federal_agency: Generated<'yes' | 'no' | 'unknown'>;
  debris_cubic_yards: ColumnType<string | null, number | string | null, number | string | null>;
  status: Generated<'active' | 'withdrawn'>;
}

export type OfficialReportKind =
  'sitrep' | 'briefing' | 'ida_package' | 'pda_package' | 'declaration_data' | 'media_sheet';
export type OfficialReportState = 'draft' | 'reviewed' | 'issued' | 'superseded' | 'withdrawn';

export interface OfficialReportTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  client_uuid: Uuid;
  kind: OfficialReportKind;
  sequence: number;
  title: string;
  period_from: ColumnType<Date, Date | string, Date | string>;
  period_to: ColumnType<Date, Date | string, Date | string>;
  time_zone: string;
  cutoff: ColumnType<Date, Date | string, Date | string>;
  state: Generated<OfficialReportState>;
  classification: Generated<'internal' | 'public'>;
  author_id: Uuid;
  reviewer_id: Uuid | null;
  reviewed_at: TsNullable;
  reviewed_version: number | null;
  review_note: string | null;
  issuer_id: Uuid | null;
  issued_at: TsNullable;
  amends: Uuid | null;
  facts_at: ColumnType<Date, Date | string, Date | string>;
  definitions: JsonGen<unknown[]>;
  partner_rollup: JsonGen<PartnerRollup>;
}

export interface OfficialReportSectionTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid;
  key: string;
  position: number;
  kind: 'fact' | 'judgment' | 'narrative';
  title: string;
  content: JsonGen<Record<string, unknown>>;
  sources: JsonGen<Record<string, unknown>>;
  drafted: Generated<boolean>;
  edited_by: Uuid | null;
  edited_at: TsNullable;
}

export interface OfficialReportSnapshotTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  report_id: Uuid;
  content: JsonValue;
  record_versions: JsonValue;
  reference_snapshots: JsonValue;
  content_hash: string;
  issued_by: Uuid;
  issued_at: ColumnType<Date, Date | string, Date | string>;
  reason: string;
  created_at: TsGen;
}

export interface OfficialReportLockTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  snapshot_id: Uuid;
  object_key: string;
  version_id: string | null;
  lock_mode: 'GOVERNANCE' | 'COMPLIANCE';
  retain_until: ColumnType<Date, Date | string, Date | string>;
  content_hash: string;
  written_at: TsGen;
}

export interface FemaFormMappingTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  form: string;
  fema_form_version: string;
  mapping_version: number;
  status: Generated<'draft' | 'active' | 'retired'>;
  scope: JsonGen<Record<string, unknown>>;
  fields: ColumnType<unknown[], string, string>;
  source_document: string | null;
  note: string | null;
  activated_by: Uuid | null;
  activated_at: TsNullable;
  activation_reason: string | null;
}

export interface ExportFileTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  client_uuid: Uuid;
  kind: 'ida_package' | 'official_report';
  format: 'zip' | 'pdf' | 'csv';
  report_id: Uuid | null;
  jurisdiction_tenant_id: Uuid | null;
  status: Generated<'queued' | 'ready' | 'failed'>;
  mappings: JsonGen<Record<string, unknown>>;
  figures: JsonGen<Record<string, unknown>>;
  file_name: string | null;
  object_key: string | null;
  bytes: ColumnType<string | null, number | null, number | null>;
  sha256: string | null;
  error: string | null;
  requested_by: Uuid;
  reason: string | null;
  created_at: TsGen;
  ready_at: TsNullable;
}

export interface PackagePhotoTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  photo_id: Uuid;
  caption: string;
  checked: boolean;
  chosen_by: Uuid;
  chosen_at: TsGen;
  removed_at: TsNullable;
  removed_by: Uuid | null;
}

export type JointPdaDegree = 'affected' | 'minor' | 'major' | 'destroyed';

export interface JointPdaTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  starts_on: ColumnType<Date | null, Date | string | null, Date | string | null>;
  ends_on: ColumnType<Date | null, Date | string | null, Date | string | null>;
  areas: Generated<string[]>;
  teams: JsonGen<{ name: string; members: string }[]>;
  status: Generated<'planned' | 'in_progress' | 'done'>;
  sample_version: Generated<number>;
  sample_size: number | null;
  sample_seed: number | null;
  sampled_at: TsNullable;
  sampled_by: Uuid | null;
  version: Generated<number>;
  created_at: TsGen;
  created_by: Uuid | null;
  updated_at: TsGen;
  updated_by: Uuid | null;
}

export interface JointPdaStopTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  joint_pda_id: Uuid;
  sample_version: number;
  seq: number;
  record_kind: 'report' | 'assessment';
  record_id: Uuid;
  stratum: JointPdaDegree;
  created_at: TsGen;
}

export interface JointPdaMarkTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  stop_id: Uuid;
  result: 'validated' | 'different' | 'not_seen';
  degree_seen: JointPdaDegree | 'no_damage' | null;
  note: string | null;
  marked_by: Uuid;
  marked_at: TsGen;
}

export interface EquityAlertTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  event_id: Uuid;
  kind: 'coverage' | 'review_gap' | 'help_gap';
  subject_kind: 'tract' | 'income_band' | 'tenure' | 'language' | 'channel';
  subject: string;
  label: string;
  value: ColumnType<string | null, number | string | null, number | string | null>;
  threshold: ColumnType<string, number | string, number | string>;
  outreach: string;
  raised_at: TsGen;
  cleared_at: TsNullable;
  acknowledged_by: Uuid | null;
  acknowledged_at: TsNullable;
  action_taken: string | null;
  version: Generated<number>;
  updated_at: TsGen;
}

export type ApiKeyScope = 'pda.read';
export type WebhookEvent = 'official_report.issued' | 'export.ready';

export interface ApiKeyTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: ApiKeyScope[];
  status: Generated<'pending' | 'active' | 'declined' | 'revoked'>;
  expires_at: Ts;
  created_by: Uuid;
  decided_by: Uuid | null;
  decided_at: TsNullable;
  decision_reason: string | null;
  revoked_by: Uuid | null;
  revoked_at: TsNullable;
  revoked_reason: string | null;
  last_used_at: TsNullable;
  version: Generated<number>;
  created_at: TsGen;
  updated_at: TsGen;
}

export interface WebhookTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  name: string;
  url: string;
  events: WebhookEvent[];
  secret_enc: Buffer;
  status: Generated<'pending' | 'active' | 'declined' | 'disabled'>;
  created_by: Uuid;
  decided_by: Uuid | null;
  decided_at: TsNullable;
  decision_reason: string | null;
  disabled_by: Uuid | null;
  disabled_at: TsNullable;
  disabled_reason: string | null;
  version: Generated<number>;
  created_at: TsGen;
  updated_at: TsGen;
}

export interface WebhookDeliveryTable {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  webhook_id: Uuid;
  event: WebhookEvent;
  subject_id: Uuid;
  payload: JsonValue;
  status: Generated<'pending' | 'delivered' | 'failed'>;
  attempts: Generated<number>;
  next_attempt_at: TsNullable;
  last_attempt_at: TsNullable;
  last_status: number | null;
  last_error: string | null;
  delivered_at: TsNullable;
  version: Generated<number>;
  created_at: TsGen;
  updated_at: TsGen;
}

export interface LocationGeoTable {
  location_id: Uuid;
  tenant_id: Uuid;
  tract_geoid: string | null;
  tract_snapshot_id: Uuid | null;
  jurisdiction_tenant_id: Uuid | null;
  assigned_at: TsGen;
}

export interface RefdataImportTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  dataset: ReferenceDataset;
  execution_id: Uuid;
  file_name: string;
  object_key: string;
  format: 'csv' | 'geojson' | 'gpkg' | 'shapefile';
  bytes: number;
  columns: JsonGen<string[]>;
  mapping: JsonGen<Record<string, string>>;
  vintage: string | null;
  licence: string;
  status: Generated<
    | 'uploading'
    | 'uploaded'
    | 'validating'
    | 'validated'
    | 'invalid'
    | 'applying'
    | 'applied'
    | 'failed'
  >;
  errors: JsonGen<{ row?: number; field?: string; message: string }[]>;
  row_count: Generated<number>;
  snapshot_id: Uuid | null;
}

export interface RefdataSnapshotTable extends Stamped {
  id: Generated<Uuid>;
  tenant_id: Uuid;
  dataset: ReferenceDataset;
  source: string;
  mode: 'pull' | 'recorded' | 'import';
  scope: JsonGen<Record<string, unknown>>;
  vintage: string | null;
  source_url: string | null;
  licence: string;
  status: Generated<'loading' | 'ready' | 'failed' | 'superseded'>;
  error: string | null;
  row_count: Generated<number>;
  checksum: string | null;
  retrieved_at: TsGen;
  ready_at: TsNullable;
  cited: Generated<boolean>;
  import_id: Uuid | null;
}

export interface RefdataCurrentTable {
  tenant_id: Uuid;
  dataset: ReferenceDataset;
  snapshot_id: Uuid;
  switched_at: TsGen;
}

interface RefRow {
  id: Generated<number>;
  snapshot_id: Uuid;
  tenant_id: Uuid;
}

export interface RefTractTable extends RefRow {
  geoid: string;
  name: string | null;
  state_fips: string;
  county_fips: string;
  land_m2: number | null;
  geom: ColumnType<unknown, unknown, unknown>;
}

export interface RefTractProfileTable extends RefRow {
  geoid: string;
  population: number | null;
  households: number | null;
  renter_households: number | null;
  median_household_income: number | null;
  poverty_pct: string | number | null;
  snap_households_pct: string | number | null;
  ssi_households_pct: string | number | null;
  age65_pct: string | number | null;
  disability_pct: string | number | null;
  limited_english_households: number | null;
  no_vehicle_households: number | null;
  languages: JsonGen<Record<string, number>>;
  moe: JsonGen<Record<string, number>>;
}

export type RefHomeType =
  'single_family' | 'multi_family' | 'manufactured' | 'commercial' | 'public' | 'other' | 'unknown';

export interface RefStructureTable extends RefRow {
  source_id: string;
  geom: ColumnType<unknown, unknown, unknown>;
  occupancy: string | null;
  home_type: Generated<RefHomeType>;
  units: number | null;
  stories: string | number | null;
  foundation: string | null;
  value_usd: string | number | null;
  year_built: number | null;
  tract_geoid: string | null;
}

export interface RefFloodZoneTable extends RefRow {
  zone: string;
  special_hazard: boolean;
  base_flood_elevation: string | number | null;
  geom: ColumnType<unknown, unknown, unknown>;
}

export type RefFacilityKind =
  | 'hospital'
  | 'nursing_home'
  | 'home_health'
  | 'dialysis'
  | 'school'
  | 'child_care'
  | 'eldercare'
  | 'fire_ems'
  | 'police'
  | 'water'
  | 'wastewater'
  | 'shelter'
  | 'other';

export interface RefFacilityTable extends RefRow {
  source_id: string;
  kind: RefFacilityKind;
  name: string;
  address: string | null;
  city: string | null;
  postal: string | null;
  beds: number | null;
  geom: ColumnType<unknown, unknown, unknown> | null;
}

export interface RefDeclarationTable extends RefRow {
  disaster_number: number;
  declaration_type: string;
  title: string | null;
  incident_type: string | null;
  declared_on: ColumnType<string | null, string | null, string | null>;
  incident_begin: ColumnType<string | null, string | null, string | null>;
  incident_end: ColumnType<string | null, string | null, string | null>;
  programs: ColumnType<string[], string[] | undefined, string[]>;
  designated_area: string | null;
  county_fips: string | null;
}

export interface RefNfipSummaryTable extends RefRow {
  area_kind: 'county' | 'tract';
  area_id: string;
  policies: number | null;
  residential_policies: number | null;
  coverage_usd: string | number | null;
  as_of: ColumnType<string | null, string | null, string | null>;
}

export interface RefRiskTable extends RefRow {
  geoid: string;
  nri_risk_score: string | number | null;
  nri_risk_rating: string | null;
  svi_overall: string | number | null;
  svi_themes: JsonGen<Record<string, number>>;
}

export interface RefAlertTable extends RefRow {
  alert_id: string;
  event: string;
  severity: string | null;
  urgency: string | null;
  headline: string | null;
  area_description: string | null;
  effective: TsNullable;
  expires: TsNullable;
  geom: ColumnType<unknown, unknown, unknown> | null;
}

export interface RefPowerOutageTable extends RefRow {
  county_fips: string;
  utility: string | null;
  customers_out: number | null;
  customers_served: number | null;
  as_of: Ts;
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
  'cg.channel_number': ChannelNumberTable;
  'cg.need_event': NeedEventTable;
  'cg.board_visibility': BoardVisibilityTable;
  'cg.share_grant': ShareGrantTable;
  'cg.referral': ReferralTable;
  'cg.partner_contact': PartnerContactTable;
  'cg.site': SiteTable;
  'cg.zip_centroid': ZipCentroidTable;
  'cg.resource': ResourceTable;
  'cg.resource_text': ResourceTextTable;
  'cg.publication': PublicationTable;
  'cg.notice_log': NoticeLogTable;
  'cg.credential': CredentialTable;
  'cg.team': TeamTable;
  'cg.team_member': TeamMemberTable;
  'cg.team_status': TeamStatusTable;
  'cg.field_device': FieldDeviceTable;
  'cg.check_in': CheckInTable;
  'cg.position': PositionTable;
  'cg.parcel': ParcelTable;
  'cg.mission_counter': MissionCounterTable;
  'cg.mission': MissionTable;
  'cg.mission_event': MissionEventTable;
  'cg.mission_person': MissionPersonTable;
  'cg.mission_media': MissionMediaTable;
  'cg.assignment': AssignmentTable;
  'cg.assignment_event': AssignmentEventTable;
  'cg.hazard': HazardTable;
  'cg.hazard_event': HazardEventTable;
  'cg.field_message': FieldMessageTable;
  'cg.field_message_receipt': FieldMessageReceiptTable;
  'cg.safety_alert': SafetyAlertTable;
  'cg.comms_log': CommsLogTable;
  'cg.activity_entry': ActivityEntryTable;
  'cg.significant_event': SignificantEventTable;
  'cg.reminder': ReminderTable;
  'cg.reminder_event': ReminderEventTable;
  'cg.badge': BadgeTable;
  'cg.badge_event': BadgeEventTable;
  'cg.service_log': ServiceLogTable;
  'cg.stock_movement': StockMovementTable;
  'cg.shelter_incident': ShelterIncidentTable;
  'cg.job_aid': JobAidTable;
  'cg.search_mark': SearchMarkTable;
  'cg.placard': PlacardTable;
  'cg.road_status': RoadStatusTable;
  'cg.debris_ticket': DebrisTicketTable;
  'cg.inspection': InspectionTable;
  'cg.pet_intake': PetIntakeTable;
  'cg.site_walkthrough': SiteWalkthroughTable;
  'cg.right_of_entry': RightOfEntryTable;
  'cg.volunteer_registration': VolunteerRegistrationTable;
  'cg.stock_item': StockItemTable;
  'cg.interpreter_request': InterpreterRequestTable;
  'cg.child_check_in': ChildCheckInTable;
  'cg.canvass_visit': CanvassVisitTable;
  'cg.shelter_stay': ShelterStayTable;
  'cg.health_note': HealthNoteTable;
  'cg.field_assessment': FieldAssessmentTable;
  'cg.change_feed': ChangeFeedTable;
  'cg.client_command': ClientCommandTable;
  'cg.location_geo': LocationGeoTable;
  'cg.declaration': DeclarationTable;
  'cg.outage': OutageTable;
  'cg.casualty_count': CasualtyCountTable;
  'cg.pa_site': PaSiteTable;
  'cg.ai_output': AiOutputTable;
  'cg.command_execution': CommandExecutionTable;
  'cg.ai_health_alert': AiHealthAlertTable;
  'cg.official_report': OfficialReportTable;
  'cg.official_report_section': OfficialReportSectionTable;
  'cg.official_report_snapshot': OfficialReportSnapshotTable;
  'cg.official_report_lock': OfficialReportLockTable;
  'cg.fema_form_mapping': FemaFormMappingTable;
  'cg.export_file': ExportFileTable;
  'cg.package_photo': PackagePhotoTable;
  'cg.joint_pda': JointPdaTable;
  'cg.joint_pda_stop': JointPdaStopTable;
  'cg.joint_pda_mark': JointPdaMarkTable;
  'cg.equity_alert': EquityAlertTable;
  'cg.api_key': ApiKeyTable;
  'cg.webhook': WebhookTable;
  'cg.webhook_delivery': WebhookDeliveryTable;
  'cg.refdata_import': RefdataImportTable;
  'cg.refdata_snapshot': RefdataSnapshotTable;
  'cg.refdata_current': RefdataCurrentTable;
  'cg.ref_tract': RefTractTable;
  'cg.ref_tract_profile': RefTractProfileTable;
  'cg.ref_structure': RefStructureTable;
  'cg.ref_flood_zone': RefFloodZoneTable;
  'cg.ref_facility': RefFacilityTable;
  'cg.ref_declaration': RefDeclarationTable;
  'cg.ref_nfip_summary': RefNfipSummaryTable;
  'cg.ref_risk': RefRiskTable;
  'cg.ref_alert': RefAlertTable;
  'cg.ref_power_outage': RefPowerOutageTable;
}
