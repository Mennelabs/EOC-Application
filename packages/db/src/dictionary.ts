/**
 * Data dictionary (SEC-11): the classification of every column in schema cg.
 * It drives storage (restricted → encrypted), logging (redaction), export and
 * AI context rules. Migration 0009 loads it into cg.data_dictionary and the
 * integration suite fails if any column is missing here.
 *
 * Classifications: public, internal, sensitive, restricted, cji.
 * Retention categories match cg.retention_policy.data_category.
 */
export type Classification = 'public' | 'internal' | 'sensitive' | 'restricted' | 'cji';

export interface ColumnEntry {
  c: Classification;
  r?: string; // retention category, default 'records'
  d?: string; // description
}

const standard: Record<string, ColumnEntry> = {
  id: { c: 'internal' },
  tenant_id: { c: 'internal' },
  version: { c: 'internal' },
  created_at: { c: 'internal' },
  created_by: { c: 'internal' },
  updated_at: { c: 'internal' },
  updated_by: { c: 'internal' },
};

function table(
  columns: Record<string, ColumnEntry>,
  opts: { standard?: boolean; omit?: string[] } = {},
): Record<string, ColumnEntry> {
  const merged = opts.standard === false ? { ...columns } : { ...standard, ...columns };
  for (const name of opts.omit ?? []) delete merged[name];
  return merged;
}

export const dictionary: Record<string, Record<string, ColumnEntry>> = {
  tenant: table(
    {
      kind: { c: 'public' },
      parent_id: { c: 'internal' },
      path: { c: 'internal' },
      slug: { c: 'public' },
      name: { c: 'public' },
      timezone: { c: 'public' },
      locales: { c: 'public' },
      status: { c: 'internal' },
      security_contact_email: {
        c: 'internal',
        d: 'Contact for break-glass and incident notices (SEC-08, SEC-19)',
      },
      branding: { c: 'public', d: 'Publicly readable branding (BRD:FR-18.02)' },
    },
    { omit: ['tenant_id'] },
  ),
  jurisdiction: table({ fips: { c: 'public' }, geom: { c: 'public' } }, { omit: ['id'] }),
  license: table({
    tier: { c: 'internal' },
    population_served: { c: 'internal' },
    term_start: { c: 'internal' },
    term_end: { c: 'internal' },
    covers_tenant_ids: { c: 'internal' },
    status: { c: 'internal' },
  }),
  data_sharing_agreement: table(
    {
      from_tenant_id: { c: 'internal' },
      to_tenant_id: { c: 'internal' },
      scope: { c: 'internal' },
      data_categories: { c: 'internal' },
      status: { c: 'internal' },
      terms: { c: 'internal' },
      signed_at: { c: 'internal' },
      signed_by: { c: 'internal' },
      revoked_at: { c: 'internal' },
      revoked_by: { c: 'internal' },
    },
    { omit: ['tenant_id'] },
  ),
  tenant_config: table({ key: { c: 'internal' }, value: { c: 'internal' } }, { omit: ['id'] }),
  tenant_config_history: table(
    {
      id: { c: 'internal' },
      tenant_id: { c: 'internal' },
      key: { c: 'internal' },
      version: { c: 'internal' },
      value: { c: 'internal' },
      changed_at: { c: 'internal' },
      changed_by: { c: 'internal' },
      reason: { c: 'internal' },
    },
    { standard: false },
  ),
  event_template: table({
    hazard_type: { c: 'public' },
    name: { c: 'public' },
    config: { c: 'internal' },
  }),
  event: table({
    template_id: { c: 'internal' },
    name: { c: 'public' },
    hazard_type: { c: 'public' },
    status: { c: 'public' },
    intake_slug: { c: 'public' },
    intake_keywords: { c: 'public' },
    opened_at: { c: 'public' },
    closed_at: { c: 'public' },
    close_reason: { c: 'internal' },
    footprint: { c: 'internal' },
  }),
  event_participant: table(
    {
      event_id: { c: 'internal' },
      tenant_id: { c: 'internal' },
      role: { c: 'internal' },
      added_at: { c: 'internal' },
      added_by: { c: 'internal' },
    },
    { standard: false },
  ),
  account: table({
    idp_subject: { c: 'sensitive', d: 'Identity-provider subject; never logged' },
    email: { c: 'sensitive', d: 'Staff email, needed for sign-in matching' },
    display_name: { c: 'internal' },
    status: { c: 'internal' },
    invited_at: { c: 'internal' },
    activated_at: { c: 'internal' },
    suspended_at: { c: 'internal' },
    deactivated_at: { c: 'internal' },
    last_login_at: { c: 'internal' },
  }),
  account_lifecycle: table(
    {
      id: { c: 'internal' },
      tenant_id: { c: 'internal' },
      account_id: { c: 'internal' },
      from_status: { c: 'internal' },
      to_status: { c: 'internal' },
      reason: { c: 'internal' },
      actor_account_id: { c: 'internal' },
      at: { c: 'internal' },
    },
    { standard: false },
  ),
  personnel: table({
    account_id: { c: 'internal' },
    name: { c: 'sensitive' },
    agency: { c: 'internal' },
    department: { c: 'internal' },
    operational_role: { c: 'internal' },
    skills: { c: 'internal' },
    duty_status: { c: 'internal' },
    availability: { c: 'internal' },
    status: { c: 'internal' },
    contact_enc: { c: 'restricted', d: 'Encrypted contact details (SEC-10)' },
    phone_bidx: { c: 'restricted', d: 'Blind index (HMAC) of phone for exact match' },
  }),
  role: table({
    key: { c: 'internal' },
    name: { c: 'internal' },
    description: { c: 'internal' },
    template_key: { c: 'internal' },
    current_version: { c: 'internal' },
    status: { c: 'internal' },
  }),
  role_version: table(
    {
      id: { c: 'internal' },
      tenant_id: { c: 'internal' },
      role_id: { c: 'internal' },
      version: { c: 'internal' },
      grants: { c: 'internal' },
      change_reason: { c: 'internal' },
      created_at: { c: 'internal' },
      created_by: { c: 'internal' },
    },
    { standard: false },
  ),
  role_assignment: table({
    account_id: { c: 'internal' },
    role_id: { c: 'internal' },
    scope: { c: 'internal' },
    valid_from: { c: 'internal' },
    valid_to: { c: 'internal' },
    status: { c: 'internal' },
    granted_by: { c: 'internal' },
    approved_by: { c: 'internal' },
    change_request_id: { c: 'internal' },
    revoked_at: { c: 'internal' },
    revoked_by: { c: 'internal' },
    revoke_reason: { c: 'internal' },
  }),
  permission_change_request: table({
    kind: { c: 'internal' },
    payload: { c: 'internal' },
    requested_by: { c: 'internal' },
    requested_at: { c: 'internal' },
    status: { c: 'internal' },
    decided_by: { c: 'internal' },
    decided_at: { c: 'internal' },
    decision_reason: { c: 'internal' },
    applied_at: { c: 'internal' },
    expires_at: { c: 'internal' },
  }),
  break_glass_session: table({
    account_id: { c: 'internal' },
    reason: { c: 'sensitive' },
    started_at: { c: 'internal' },
    expires_at: { c: 'internal' },
    ended_at: { c: 'internal' },
    ended_by: { c: 'internal' },
    notified_at: { c: 'internal' },
    notified_to: { c: 'internal' },
  }),
  audit_event: table(
    {
      seq: { c: 'internal', r: 'audit' },
      tenant_id: { c: 'internal', r: 'audit' },
      occurred_at: { c: 'internal', r: 'audit' },
      recorded_at: { c: 'internal', r: 'audit' },
      actor_account_id: { c: 'internal', r: 'audit' },
      actor_kind: { c: 'internal', r: 'audit' },
      action: { c: 'internal', r: 'audit' },
      target_type: { c: 'internal', r: 'audit' },
      target_id: { c: 'internal', r: 'audit' },
      target_version: { c: 'internal', r: 'audit' },
      changes: {
        c: 'sensitive',
        r: 'audit',
        d: 'Field diffs; restricted values are hashed, not stored',
      },
      execution_id: { c: 'internal', r: 'audit' },
      request_id: { c: 'internal', r: 'audit' },
      classification_read: { c: 'internal', r: 'audit' },
      reason: { c: 'internal', r: 'audit' },
      prev_hash: { c: 'internal', r: 'audit' },
      hash: { c: 'internal', r: 'audit' },
    },
    { standard: false },
  ),
  audit_anchor: table(
    {
      id: { c: 'internal', r: 'audit' },
      tenant_id: { c: 'internal', r: 'audit' },
      through_seq: { c: 'internal', r: 'audit' },
      hash: { c: 'internal', r: 'audit' },
      anchored_at: { c: 'internal', r: 'audit' },
      object_key: { c: 'internal', r: 'audit' },
    },
    { standard: false },
  ),
  data_dictionary: table(
    {
      table_name: { c: 'public' },
      column_name: { c: 'public' },
      classification: { c: 'public' },
      retention_category: { c: 'public' },
      description: { c: 'public' },
    },
    { standard: false },
  ),
  tenant_key: table(
    {
      tenant_id: { c: 'internal' },
      key_version: { c: 'internal' },
      kek_name: { c: 'internal' },
      wrapped_dek: { c: 'restricted', d: 'Wrapped data key; useless without the key service' },
      status: { c: 'internal' },
      created_at: { c: 'internal' },
      retired_at: { c: 'internal' },
    },
    { standard: false },
  ),
  retention_policy: table(
    {
      data_category: { c: 'internal' },
      keep_for: { c: 'internal' },
      rule: { c: 'internal' },
      note: { c: 'internal' },
    },
    { omit: ['id'] },
  ),
  legal_hold: table({
    scope: { c: 'internal' },
    reason: { c: 'sensitive' },
    placed_by: { c: 'internal' },
    placed_at: { c: 'internal' },
    released_by: { c: 'internal' },
    released_at: { c: 'internal' },
  }),
  deletion_log: table(
    {
      id: { c: 'internal', r: 'audit' },
      tenant_id: { c: 'internal', r: 'audit' },
      data_category: { c: 'internal', r: 'audit' },
      target_type: { c: 'internal', r: 'audit' },
      deleted_count: { c: 'internal', r: 'audit' },
      oldest: { c: 'internal', r: 'audit' },
      newest: { c: 'internal', r: 'audit' },
      ran_at: { c: 'internal', r: 'audit' },
      execution_id: { c: 'internal', r: 'audit' },
    },
    { standard: false },
  ),
  idempotency_key: table(
    {
      tenant_id: { c: 'internal' },
      scope: { c: 'internal' },
      key: { c: 'internal' },
      request_hash: { c: 'internal' },
      status: { c: 'internal' },
      response_status: { c: 'internal' },
      response_body: { c: 'sensitive', d: 'Replayed response; may echo submitted data' },
      created_at: { c: 'internal' },
      expires_at: { c: 'internal' },
    },
    { standard: false },
  ),
  governed_definition: table(
    {
      tenant_id: { c: 'internal' },
      key: { c: 'internal' },
      version: { c: 'internal' },
      value: { c: 'internal' },
      reason: { c: 'internal' },
      effective_from: { c: 'internal' },
      created_at: { c: 'internal' },
      created_by: { c: 'internal' },
    },
    { standard: false },
  ),
  outbox: table(
    {
      id: { c: 'internal' },
      tenant_id: { c: 'internal' },
      topic: { c: 'internal' },
      payload: { c: 'sensitive', d: 'Event payloads may carry record data' },
      execution_id: { c: 'internal' },
      created_at: { c: 'internal' },
      published_at: { c: 'internal' },
      attempts: { c: 'internal' },
      last_error: { c: 'internal' },
    },
    { standard: false },
  ),
};

/** Columns that must be encrypted at the application layer (SEC-10). */
export function restrictedColumns(): { table: string; column: string }[] {
  return Object.entries(dictionary).flatMap(([t, cols]) =>
    Object.entries(cols)
      .filter(([, e]) => e.c === 'restricted' || e.c === 'cji')
      .map(([column]) => ({ table: t, column })),
  );
}

/** Column names the logger must never print (sensitive or stricter). */
export function redactedColumnNames(): string[] {
  const names = new Set<string>();
  for (const cols of Object.values(dictionary)) {
    for (const [name, e] of Object.entries(cols)) {
      if (e.c !== 'public' && e.c !== 'internal') names.add(name);
    }
  }
  return [...names].sort();
}
