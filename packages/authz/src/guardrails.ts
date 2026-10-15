/**
 * Guardrails no county can configure away (ADM-05). They run before any
 * role grant is consulted and a deny here is final. Each has its own test
 * file in packages/authz/test. Numbering follows ADM-05 and the layer-1 plan.
 *
 *  G1  default deny, server-side, fresh subject at execution (BRD:FR-00.01, AC-C05)
 *  G2  public users never see private records (BRD:FR-00.02, RULE-17)
 *  G3  criminal-justice data only in a CJIS enclave session (SEC-12)
 *  G4  no approving your own finding without an audited policy exception (A7, AC-12B)
 *  G5  nobody edits or deletes audit records (BRD:FR-08.04)
 *  G6  permission grants need a second administrator; none during break-glass
 *  G7  restricted health, counseling, legal and access-needs fields stay with their roles
 *      (FL:FR-15, FL:FR-16, FL:FR-23, RULE-16) — enforced as a field mask in engine.ts
 */
import { actions, isActionKey, SELF_REVIEW_ACTIONS, type ActionMeta } from './actions.ts';
import { CATEGORY_TEMPLATES } from './templates.ts';
import {
  TEMPLATE_PROTECTED_CATEGORIES,
  type DataCategory,
  type GuardrailId,
  type Resource,
  type Subject,
  type TenantPolicy,
} from './types.ts';

export interface GuardrailContext {
  subject: Subject;
  actionKey: string;
  action: ActionMeta | undefined;
  resource: Resource;
  policy: TenantPolicy;
  now: Date;
}

export interface GuardrailOutcome {
  deny?: string;
  auditReason?: string;
}

export interface Guardrail {
  id: GuardrailId;
  title: string;
  check(ctx: GuardrailContext): GuardrailOutcome | undefined;
}

const DEFAULT_MAX_SUBJECT_AGE_MS = 5 * 60 * 1000;

export const G1: Guardrail = {
  id: 'G1',
  title: 'Default deny; server-side; fresh subject at execution',
  check({ subject, actionKey, action, policy, now }) {
    if (!action || !isActionKey(actionKey)) return { deny: 'unknown_action' };
    if (subject.kind === 'account') {
      if (!subject.accountId || !subject.tenantId) return { deny: 'subject_incomplete' };
      const maxAge = policy.maxSubjectAgeMs ?? DEFAULT_MAX_SUBJECT_AGE_MS;
      if (now.getTime() - subject.resolvedAt.getTime() > maxAge) return { deny: 'subject_stale' };
    }
    return undefined;
  },
};

export const G2: Guardrail = {
  id: 'G2',
  title: 'Public users never see private records',
  check({ subject, action, resource }) {
    if (subject.kind !== 'public') return undefined;
    if (!action?.public) return { deny: 'public_action_not_allowed' };
    if (resource.published === false) return { deny: 'public_record_not_published' };
    const privateField = resource.fields?.find((f) => f.classification !== 'public');
    if (privateField) return { deny: 'public_private_field' };
    return undefined;
  },
};

export const G3: Guardrail = {
  id: 'G3',
  title: 'Criminal-justice data only for CJIS enclave sessions',
  check({ subject, resource }) {
    const touchesCji =
      resource.type.startsWith('cji') ||
      resource.fields?.some((f) => f.classification === 'cji' || f.category === 'cji');
    if (!touchesCji) return undefined;
    if (subject.kind === 'account' && subject.enclaveSession === true) return undefined;
    return { deny: 'cji_requires_enclave_session' };
  },
};

export const G4: Guardrail = {
  id: 'G4',
  title: 'No approving your own finding without an audited policy exception',
  check({ subject, actionKey, resource, policy }) {
    if (!SELF_REVIEW_ACTIONS.includes(actionKey)) return undefined;
    if (subject.kind !== 'account' || !resource.recordedBy) return undefined;
    if (resource.recordedBy !== subject.accountId) return undefined;
    if (policy.selfReviewException === true) return { auditReason: 'self_review_exception' };
    return { deny: 'self_review' };
  },
};

export const G5: Guardrail = {
  id: 'G5',
  title: 'Nobody edits or deletes audit records',
  check({ action, resource }) {
    if (resource.type !== 'audit_event' && resource.type !== 'audit_anchor') return undefined;
    if (action && (action.kind === 'read' || action.kind === 'export')) return undefined;
    return { deny: 'audit_immutable' };
  },
};

const PERMISSION_WRITE_PREFIXES = [
  'permission_change.',
  'role.',
  'role_assignment.',
  // SCL-09: an API key or a webhook is access granted to a system outside.
  'api_key.',
  'webhook.',
];

export const G6: Guardrail = {
  id: 'G6',
  title: 'Granting permissions needs a second administrator',
  check({ subject, actionKey, action, resource }) {
    if (subject.kind !== 'account') return undefined;
    const isPermissionWrite =
      action &&
      action.kind !== 'read' &&
      PERMISSION_WRITE_PREFIXES.some((p) => actionKey.startsWith(p));
    if (isPermissionWrite && subject.breakGlass)
      return { deny: 'permissions_frozen_during_break_glass' };
    if (actionKey === 'permission_change.approve' && resource.requestedBy === subject.accountId) {
      return { deny: 'second_administrator_required' };
    }
    if (actionKey === 'role_assignment.create') {
      if (!resource.changeRequestId || resource.changeRequestApproved !== true) {
        return { deny: 'assignment_requires_approved_change_request' };
      }
      if (resource.requestedBy === subject.accountId) {
        // The requester may not also be the one applying it: approval and
        // application are both by the second administrator.
        return { deny: 'second_administrator_required' };
      }
    }
    if (actionKey === 'role.publish' && resource.requestedBy === subject.accountId) {
      return { deny: 'second_administrator_required' };
    }
    // SCL-09: a key or webhook is approved or declined by someone other than who asked.
    if (
      (actionKey === 'api_key.manage' || actionKey === 'webhook.manage') &&
      resource.requestedBy !== undefined &&
      resource.requestedBy === subject.accountId
    ) {
      return { deny: 'second_administrator_required' };
    }
    return undefined;
  },
};

/**
 * G7 is enforced as a mask (engine.ts): a field in a template-protected
 * category is visible only when the subject holds a role whose template is
 * listed for that category. This helper answers that question.
 */
export function qualifiedProtectedCategories(subject: Subject): Set<DataCategory> {
  const out = new Set<DataCategory>();
  if (subject.kind !== 'account') return out;
  for (const category of TEMPLATE_PROTECTED_CATEGORIES) {
    const templates = CATEGORY_TEMPLATES[category] ?? [];
    if (subject.roles.some((r) => r.templateKey && templates.includes(r.templateKey))) {
      out.add(category);
    }
  }
  return out;
}

export const G7: Guardrail = {
  id: 'G7',
  title: 'Restricted health, counseling, legal and access-needs fields stay with their roles',
  check({ subject, action, resource }) {
    // Writes to a protected category by an unqualified role are refused outright;
    // reads are masked in the engine so the rest of the record stays usable.
    if (!action || action.kind === 'read') return undefined;
    const qualified = qualifiedProtectedCategories(subject);
    const blocked = resource.fields?.find(
      (f) => TEMPLATE_PROTECTED_CATEGORIES.includes(f.category) && !qualified.has(f.category),
    );
    if (blocked && subject.kind !== 'system')
      return { deny: `protected_category:${blocked.category}` };
    return undefined;
  },
};

export const guardrails: readonly Guardrail[] = [G1, G2, G3, G4, G5, G6, G7];

export { actions };
