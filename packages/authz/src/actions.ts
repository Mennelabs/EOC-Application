/**
 * Action catalog (BRD:FR-C03, NFR-11): every governed operation, callable
 * manually, by the field app, or later by the command window, with the same
 * authorization. Layer 1 lists the foundation actions; each layer extends it.
 * An action not in the catalog is denied (default deny).
 */
export type ActionKind = 'read' | 'write' | 'export' | 'admin';

export interface ActionMeta {
  kind: ActionKind;
  resource: string;
  description: string;
  /** Allowed for unauthenticated subjects (within guardrail G2). */
  public?: boolean;
  /** RULE-14: confirmation and reason required. */
  consequential?: boolean;
}

const a = (
  kind: ActionKind,
  resource: string,
  description: string,
  extra: Partial<ActionMeta> = {},
): ActionMeta => ({ kind, resource, description, ...extra });

export const actions = {
  'meta.read': a('read', 'meta', 'Public product metadata and branding', { public: true }),
  'me.read': a('read', 'account', 'Own account, roles and active sessions'),

  'tenant.read': a('read', 'tenant', 'Tenant details and hierarchy'),
  'tenant.create_child': a(
    'admin',
    'tenant',
    'Create a child tenant (region, county, city, partner)',
    {
      consequential: true,
    },
  ),
  'tenant.update': a('admin', 'tenant', 'Update tenant details, locales, branding, status', {
    consequential: true,
  }),
  'tenant.config.read': a('read', 'tenant_config', 'Read tenant configuration'),
  'tenant.config.write': a('admin', 'tenant_config', 'Change tenant configuration (versioned)', {
    consequential: true,
  }),
  'license.read': a('read', 'license', 'Read subscription and covered jurisdictions'),
  'license.write': a('admin', 'license', 'Set subscription tier and term', { consequential: true }),

  'dsa.read': a('read', 'data_sharing_agreement', 'Read data-sharing agreements'),
  'dsa.create': a('write', 'data_sharing_agreement', 'Draft an agreement with another tenant'),
  'dsa.sign': a('admin', 'data_sharing_agreement', 'Sign an agreement', { consequential: true }),
  'dsa.revoke': a('admin', 'data_sharing_agreement', 'Revoke an agreement', {
    consequential: true,
  }),

  'event.read': a('read', 'event', 'Read events'),
  'event.create': a('write', 'event', 'Create an event from a template'),
  'event.update': a('write', 'event', 'Update event details and footprint'),
  'event.open': a('write', 'event', 'Open an event and publish its intake link and keyword', {
    consequential: true,
  }),
  'event.close': a('write', 'event', 'Close an event', { consequential: true }),
  'event.participant.add': a('write', 'event', 'Invite a partner tenant to an event'),

  'account.read': a('read', 'account', 'List and read staff accounts'),
  'account.invite': a('admin', 'account', 'Invite a staff account'),
  'account.activate': a('admin', 'account', 'Activate an invited account'),
  'account.suspend': a('admin', 'account', 'Suspend an account', { consequential: true }),
  'account.deactivate': a('admin', 'account', 'Deactivate an account (history kept)', {
    consequential: true,
  }),

  'personnel.read': a('read', 'personnel', 'Read personnel records'),
  'personnel.create': a('write', 'personnel', 'Create a personnel record'),
  'personnel.update': a('write', 'personnel', 'Update skills, agency, availability'),
  'personnel.archive': a('write', 'personnel', 'Archive a personnel record', {
    consequential: true,
  }),

  'role.read': a('read', 'role', 'Read roles and their versions'),
  'role.create': a('admin', 'role', 'Create a role from a template or from scratch'),
  'role.edit': a('admin', 'role', 'Draft a new version of a role'),
  'role.publish': a('admin', 'role', 'Publish a role version (needs a second administrator)', {
    consequential: true,
  }),
  'role.retire': a('admin', 'role', 'Retire a role', { consequential: true }),
  'role.preview': a('read', 'role', 'What can this role do'),

  'permission_change.read': a(
    'read',
    'permission_change_request',
    'Read pending permission changes',
  ),
  'permission_change.request': a(
    'admin',
    'permission_change_request',
    'Request a permission change',
  ),
  'permission_change.approve': a(
    'admin',
    'permission_change_request',
    'Approve a permission change requested by someone else',
    { consequential: true },
  ),
  'permission_change.reject': a('admin', 'permission_change_request', 'Reject a permission change'),
  'permission_change.withdraw': a('admin', 'permission_change_request', 'Withdraw own request'),

  'role_assignment.read': a('read', 'role_assignment', 'Read who holds which role'),
  'role_assignment.create': a('admin', 'role_assignment', 'Apply an approved assignment', {
    consequential: true,
  }),
  'role_assignment.revoke': a('admin', 'role_assignment', 'Revoke an assignment at once', {
    consequential: true,
  }),

  'break_glass.start': a(
    'admin',
    'break_glass_session',
    'Start a time-boxed emergency read session',
    {
      consequential: true,
    },
  ),
  'break_glass.end': a('admin', 'break_glass_session', 'End a break-glass session early'),
  'break_glass.read': a('read', 'break_glass_session', 'Read break-glass sessions'),

  'audit.read': a('read', 'audit_event', 'Read the audit log'),
  'audit.verify': a('read', 'audit_event', 'Verify the audit chain'),
  'audit.export': a('export', 'audit_event', 'Export audit records with redaction', {
    consequential: true,
  }),

  'definition.read': a('read', 'governed_definition', 'Read governed definitions'),
  'definition.write': a('admin', 'governed_definition', 'Publish a new definition version', {
    consequential: true,
  }),
  'retention.read': a('read', 'retention_policy', 'Read retention policies'),
  'retention.write': a('admin', 'retention_policy', 'Change retention policies', {
    consequential: true,
  }),
  'legal_hold.read': a('read', 'legal_hold', 'Read legal holds'),
  'legal_hold.place': a('admin', 'legal_hold', 'Place a legal hold', { consequential: true }),
  'legal_hold.release': a('admin', 'legal_hold', 'Release a legal hold', { consequential: true }),

  // ---- Layer 2: intake, reports, review ----
  'intake.read': a(
    'read',
    'intake_graph',
    'Published question graph, branding and languages for an event',
    { public: true },
  ),
  'intake.submit': a(
    'write',
    'report',
    'Submit a damage report or a need without a staff session',
    { public: true },
  ),
  'intake.draft': a('write', 'draft', 'Pause and resume a report with a short code', {
    public: true,
  }),
  'intake.upload': a('write', 'photo', 'Upload photos for a submission', { public: true }),
  'intake.extract': a('read', 'extraction', 'Candidate answers from free text (fixed schema)', {
    public: true,
  }),
  'intake.lookup': a('read', 'report', 'Start and verify a reference-code lookup (one-time code)', {
    public: true,
  }),
  'report.self_read': a('read', 'report', 'Read own report after verification', { public: true }),
  'report.self_update': a(
    'write',
    'report',
    'Correct, add to, withdraw own report or change consent',
    { public: true },
  ),
  'intake_graph.read': a('read', 'intake_graph', 'Read question graph versions'),
  'intake_graph.edit': a('admin', 'intake_graph', 'Draft a new question graph version'),
  'intake_graph.publish': a('admin', 'intake_graph', 'Publish a question graph version', {
    consequential: true,
  }),
  'report.read': a('read', 'report', 'Read damage reports and the review queue'),
  'report.create_assisted': a(
    'write',
    'report',
    "Record a report on a resident's behalf (assisted intake)",
  ),
  'report.update': a('write', 'report', "Update a report's location or answers as a reviewer"),
  'report.review': a(
    'write',
    'report',
    'Decide: approve, reject, needs information, duplicate, supersede, reopen',
    { consequential: true },
  ),
  'report.verify': a('write', 'report', 'Set the verification level'),
  'report.set_degree': a('write', 'report', 'Set the official FEMA degree of damage', {
    consequential: true,
  }),
  'report.request_information': a('write', 'report', 'Ask the resident for more information'),
  'photo.read': a('read', 'photo', 'Read photos (originals need the evidence category)'),
  'need.read': a('read', 'need', 'Read needs'),
  'need.update': a('write', 'need', "Update a need's status"),
  'consent.read': a('read', 'consent', 'Read sharing consent'),
  'message.read': a('read', 'message', 'Read messages sent to residents'),
  'intake_session.read': a(
    'read',
    'intake_session',
    'Read SMS and voice sessions (agent hand-off)',
  ),
  'ai_register.read': a('read', 'ai_use_register', 'Read the AI use register'),
  'ai_register.write': a(
    'admin',
    'ai_use_register',
    'Enable or disable an AI feature for the tenant',
    { consequential: true },
  ),
} as const satisfies Record<string, ActionMeta>;

export type ActionKey = keyof typeof actions;

export function isActionKey(key: string): key is ActionKey {
  return Object.hasOwn(actions, key);
}

/** Does a grant pattern cover an action? '*' and 'family.*' are the only wildcards. */
export function actionMatches(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const family = pattern.slice(0, -1); // keep the trailing dot
    return action.startsWith(family);
  }
  return pattern === action;
}

/** A7 / AC-12B: approving a finding the same person recorded. */
export const SELF_REVIEW_ACTIONS: readonly string[] = [
  'report.approve',
  'report.review',
  'report.verify',
  'report.set_degree',
  'assessment.approve',
  'finding.approve',
];
