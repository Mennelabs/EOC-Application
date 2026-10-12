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
  'assessment.approve',
  'finding.approve',
];
