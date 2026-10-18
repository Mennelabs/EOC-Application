/**
 * Enclave data dictionary (SEC-11, SEC-12): the classification of every
 * column in schema `cjis`. `cji` marks criminal-justice information, which
 * the enclave stores encrypted under the owning agency's key (SEC-10) and
 * never logs. Each migration that adds columns reloads this file; the load
 * fails on any column without an entry, and the drill (migrate-check.ts)
 * fails on any entry the final schema lacks.
 */
import { sql, type Kysely } from 'kysely';

export type Classification = 'public' | 'internal' | 'sensitive' | 'restricted' | 'cji';

export interface ColumnEntry {
  c: Classification;
  /** Retention category, default 'records' (SEC-13). */
  r?: string;
  d?: string;
}

const i: ColumnEntry = { c: 'internal' };
/** CJI kept in plain columns because the enclave filters on them (codes, roles, kinds). */
const code = (d: string): ColumnEntry => ({ c: 'cji', d });
/** CJI encrypted under the agency key (SEC-10). */
const enc = (d: string): ColumnEntry => ({ c: 'cji', d: `${d}; encrypted` });
const audit = (d?: string): ColumnEntry => ({ c: 'internal', r: 'audit', ...(d ? { d } : {}) });
const versioned = {
  version: i,
  created_at: i,
  created_by: i,
  updated_at: i,
  updated_by: i,
};
const removal = {
  status: i,
  removed_reason: { c: 'cji', d: 'Why an entry was removed; kept with the row (BRD:FR-07.06)' },
  removed_by: i,
  removed_at: i,
} satisfies Record<string, ColumnEntry>;

export const dictionary: Record<string, Record<string, ColumnEntry>> = {
  data_dictionary: {
    table_name: i,
    column_name: i,
    classification: i,
    retention_category: i,
    description: i,
  },
  agency: {
    id: i,
    name: { c: 'internal', d: 'Criminal-justice agency name' },
    agency_identifier: {
      c: 'internal',
      d: 'Agency identifier; exercise values only until the state CJIS audit (SCL-12)',
    },
    platform_county: { c: 'internal', d: 'Declared: the platform county this agency serves' },
    status: i,
    exercise: { c: 'internal', d: 'SCL-12: true for synthetic exercise agencies' },
    version: i,
    created_at: i,
    updated_at: i,
  },
  agency_key: {
    agency_id: i,
    version: i,
    wrapped: { c: 'restricted', d: 'Data key wrapped by the enclave key service (SEC-10)' },
    kek_name: i,
    created_at: i,
  },
  person: {
    id: i,
    agency_id: i,
    idp_subject: i,
    email: { c: 'sensitive', d: 'Enclave account email (staff, not a resident)' },
    display_name: { c: 'sensitive' },
    status: i,
    status_reason: i,
    fingerprint_status: {
      c: 'sensitive',
      d: 'Personnel screening status only (PS-3); results are never stored',
    },
    fingerprint_adjudicated_on: { c: 'sensitive' },
    fingerprint_recorded_by: i,
    training_completed_on: { c: 'sensitive', d: 'Security awareness training (AT-2)' },
    training_expires_on: { c: 'sensitive' },
    training_recorded_by: i,
    identity_state: i,
    last_seen_at: { c: 'internal', d: 'Last authenticated request; inactivity suspension (AC-2)' },
    ...versioned,
  },
  permission_request: {
    id: i,
    agency_id: i,
    person_id: i,
    role: i,
    change: i,
    status: i,
    reason: i,
    requested_by: i,
    requested_at: i,
    decided_by: i,
    decided_at: i,
    decision_reason: i,
    version: i,
    created_at: i,
    updated_at: i,
  },
  role_grant: {
    id: i,
    agency_id: i,
    person_id: i,
    role: i,
    status: i,
    request_id: i,
    granted_by: i,
    granted_at: i,
    revoked_by: i,
    revoked_at: i,
    revoke_request_id: i,
    version: i,
    updated_at: i,
  },
  identity_outbox: {
    id: i,
    agency_id: i,
    person_id: i,
    kind: i,
    payload_enc: {
      c: 'restricted',
      d: 'One-time temporary password until the identity exists; then cleared',
    },
    status: i,
    attempts: i,
    last_error: i,
    next_attempt_at: i,
    created_at: i,
    done_at: i,
  },
  idp_event_cursor: { id: i, last_time_ms: i, updated_at: i },
  record: {
    id: i,
    agency_id: i,
    cji_ref: { c: 'internal', d: 'Opaque reference the platform holds (SEC-12)' },
    platform_county: { c: 'internal', d: 'Declared by the console link' },
    platform_mission_reference: { c: 'internal', d: 'Declared by the console link' },
    origin: code('How the law-enforcement involvement began (BRD:D02 call sources)'),
    classification: code('Law-enforcement classification'),
    offense_codes: code('Offense codes'),
    case_number_enc: enc('Law-enforcement case number'),
    summary_enc: enc('Law-enforcement summary'),
    state: i,
    disposition: code('Law-enforcement disposition (BRD:FR-07.05)'),
    disposition_note_enc: enc('Disposition explanation'),
    disposition_by: i,
    disposition_at: i,
    reviewed_by: i,
    reviewed_at: i,
    closed_at: i,
    ...versioned,
  },
  record_person: {
    id: i,
    agency_id: i,
    record_id: i,
    role: code('Law-enforcement role of a person involved (PPL-01)'),
    name_enc: enc('Name'),
    birth_date_enc: enc('Date of birth'),
    demographics_enc: enc('Necessary demographics only (BRD:D07)'),
    contact_enc: enc('Contact'),
    address_enc: enc('Address'),
    identifiers_enc: enc('Identifiers such as a licence number'),
    notes_enc: enc('Notes'),
    ...removal,
    ...versioned,
  },
  record_weapon: {
    id: i,
    agency_id: i,
    record_id: i,
    person_id: i,
    kind: code('Weapon kind (SEC-12)'),
    description_enc: enc('Weapon description'),
    serial_enc: enc('Serial number'),
    disposition: code('What happened to the weapon'),
    ...removal,
    ...versioned,
  },
  record_bodycam: {
    id: i,
    agency_id: i,
    record_id: i,
    camera_label: code('Body camera label'),
    officer_person_id: i,
    recorded_from: code('Recording start'),
    recorded_to: code('Recording end'),
    evidence_reference_enc: enc('Evidence-system reference (no video in the enclave)'),
    notes_enc: enc('Notes'),
    ...removal,
    ...versioned,
  },
  record_event: {
    id: i,
    agency_id: i,
    record_id: i,
    kind: i,
    narrative_role: i,
    body_enc: enc('Narrative or amendment text'),
    amends_event_id: i,
    actor_person_id: i,
    detail: { c: 'internal', d: 'Which entries and field names changed; never values' },
    occurred_at: i,
    created_at: i,
  },
  // Mutual aid (decision 2026-10-15): one agency owns a record and grants another a read for a set period.
  record_share: {
    id: i,
    agency_id: { c: 'internal', d: 'The owning agency, which granted the share' },
    record_id: i,
    to_agency_id: { c: 'internal', d: 'The helping agency reading the record' },
    platform_mission_reference: { c: 'internal', d: 'Declared: the mission the help is for' },
    purpose: code('Why the record is shared, in one line'),
    starts_at: i,
    ends_at: { c: 'internal', d: 'Access ends by itself at this time' },
    status: i,
    granted_by: i,
    revoked_by: i,
    revoked_at: i,
    revoke_reason: { c: 'internal', d: 'Why the share was ended early' },
    ended_at: i,
    version: i,
    created_at: i,
    updated_at: i,
  },
  idempotency_key: {
    agency_id: i,
    scope: i,
    key: i,
    request_hash: i,
    status: i,
    response_status: i,
    response_body_enc: enc('Stored response for a replay'),
    expires_at: i,
    created_at: i,
  },
  audit_event: {
    seq: audit(),
    agency_id: audit(),
    occurred_at: audit(),
    recorded_at: audit(),
    actor_person_id: audit(),
    actor_kind: audit(),
    action: audit(),
    target_type: audit(),
    target_id: audit(),
    target_version: audit(),
    outcome: audit(),
    reason: audit('Short reason; never a CJI value'),
    fields: audit('Names of fields read or changed; never values'),
    request_id: audit(),
    source_ip: { c: 'sensitive', r: 'audit' },
    prev_hash: audit(),
    hash: audit(),
  },
  audit_review: {
    id: audit(),
    agency_id: audit(),
    reviewer_person_id: audit(),
    period_from: audit(),
    period_to: audit(),
    checked: audit(),
    chain_ok: audit(),
    note: audit('Weekly review note (AU-6)'),
    created_at: audit(),
  },
  retention_policy: {
    agency_id: i,
    category: i,
    keep_days: i,
    basis: { c: 'internal', d: 'The records schedule or rule the period comes from' },
    version: i,
    updated_at: i,
    updated_by: i,
  },
  legal_hold: {
    id: i,
    agency_id: i,
    record_id: i,
    reason: { c: 'sensitive' },
    placed_by: i,
    placed_at: i,
    released_by: i,
    released_at: i,
    release_reason: { c: 'sensitive' },
    version: i,
    updated_at: i,
  },
  deletion_log: {
    id: i,
    agency_id: i,
    category: i,
    cutoff: i,
    deleted: i,
    held: i,
    ran_at: i,
  },
};

/** Columns stored encrypted under the agency key (SEC-10). */
export function encryptedColumns(): { table: string; column: string }[] {
  return Object.entries(dictionary).flatMap(([t, cols]) =>
    Object.entries(cols)
      .filter(([name, e]) => (e.c === 'cji' || e.c === 'restricted') && name.endsWith('_enc'))
      .map(([column]) => ({ table: t, column })),
  );
}

/** Column names the enclave logger must never print. */
export function redactedColumnNames(): string[] {
  const names = new Set<string>();
  for (const cols of Object.values(dictionary)) {
    for (const [name, e] of Object.entries(cols)) {
      if (e.c !== 'public' && e.c !== 'internal') names.add(name);
    }
  }
  return [...names].sort();
}

/** Loads the entries for the columns that exist now and refuses any undocumented column. */
export async function loadDictionary(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ table_name: string; column_name: string }>`
    select c.table_name::text, c.column_name::text
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'cjis' and t.table_type = 'BASE TABLE'`.execute(db);
  const columns = new Set(existing.rows.map((r) => `${r.table_name}.${r.column_name}`));
  await sql`delete from cjis.data_dictionary`.execute(db);
  for (const [table, cols] of Object.entries(dictionary)) {
    for (const [column, e] of Object.entries(cols)) {
      if (!columns.has(`${table}.${column}`)) continue;
      await sql`
        insert into cjis.data_dictionary (table_name, column_name, classification, retention_category, description)
        values (${table}, ${column}, ${e.c}, ${e.r ?? 'records'}, ${e.d ?? null})`.execute(db);
    }
  }
  const missing = await sql<{ table_name: string; column_name: string }>`
    select * from cjis.undocumented_columns()`.execute(db);
  if (missing.rows.length > 0) {
    const list = missing.rows.map((m) => `${m.table_name}.${m.column_name}`).join(', ');
    throw new Error(`SEC-11: enclave columns without a data-dictionary entry: ${list}`);
  }
}
