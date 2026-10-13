/**
 * decide(): the one authorization function (ADR-0011). Order of evaluation:
 *   1. guardrails G1–G7 (code, not configurable)  → hard deny
 *   2. system subject                              → allow
 *   3. public subject                              → allow public fields only
 *   4. account: active status, role grants         → allow with a field mask
 *      (or break-glass read within own tenant)
 *   5. otherwise                                   → deny (default deny)
 */
import { actionMatches, actions, isActionKey, type ActionMeta } from './actions.ts';
import { guardrails, qualifiedProtectedCategories } from './guardrails.ts';
import {
  TEMPLATE_PROTECTED_CATEGORIES,
  type AccountSubject,
  type DataCategory,
  type Decision,
  type FieldDescriptor,
  type Grant,
  type ResolvedRole,
  type Resource,
  type Subject,
  type TenantPolicy,
} from './types.ts';

export interface DecideOptions {
  policy?: TenantPolicy;
  now?: Date;
}

function deny(reason: string, consequential: boolean, guardrail?: Decision['guardrail']): Decision {
  return {
    effect: 'deny',
    reason,
    ...(guardrail ? { guardrail } : {}),
    fields: [],
    maskedFields: [],
    restrictedRead: [],
    consequential,
    recordScope: 'own',
  };
}

function tenantInScope(
  grant: Grant,
  subject: AccountSubject,
  resource: Resource,
  actionKind: ActionMeta['kind'],
): boolean {
  const scope = grant.tenants ?? 'own';
  const target = resource.tenantId ?? subject.tenantId;
  if (scope === 'own') {
    if (target === subject.tenantId) return true;
    // Records shared by a signed agreement are readable, never writable (SCL-01).
    return actionKind === 'read' && (subject.agreementTenantIds ?? []).includes(target);
  }
  if (scope === 'subtree') {
    const path = resource.tenantPath;
    return target === subject.tenantId || (!!path && path.startsWith(subject.tenantPath));
  }
  return scope.includes(target);
}

function eventInScope(grant: Grant, role: ResolvedRole, resource: Resource): boolean {
  const scope = grant.events ?? 'all';
  if (scope === 'all') return true;
  if (!resource.eventId) return true; // not an event-scoped record
  return (role.scope.eventIds ?? []).includes(resource.eventId);
}

/**
 * FLD-14: a grant limited to held records covers a list (no id: the route
 * filters by `recordScope`) and a single record only when the route says the
 * subject holds it; an identified record without that answer is not held.
 */
function recordInScope(grant: Grant, resource: Resource): boolean {
  if ((grant.records ?? 'all') === 'all') return true;
  if (resource.id === undefined) return true;
  return resource.heldBySubject === true;
}

function mask(
  fields: FieldDescriptor[] | undefined,
  allowed: Set<DataCategory>,
  qualifiedProtected: Set<DataCategory>,
): { fields: string[]; masked: string[]; restrictedRead: DataCategory[] } {
  if (!fields) return { fields: [], masked: [], restrictedRead: [] };
  const out: string[] = [];
  const masked: string[] = [];
  const restricted = new Set<DataCategory>();
  for (const f of fields) {
    if (f.category === 'cji' || f.classification === 'cji') {
      masked.push(f.name);
      continue;
    }
    const protectedCategory = TEMPLATE_PROTECTED_CATEGORIES.includes(f.category);
    const ok = protectedCategory
      ? qualifiedProtected.has(f.category)
      : f.category === 'basic' || allowed.has(f.category);
    if (ok) {
      out.push(f.name);
      if (f.classification === 'restricted' || protectedCategory) restricted.add(f.category);
    } else {
      masked.push(f.name);
    }
  }
  return { fields: out, masked, restrictedRead: [...restricted] };
}

export function decide(
  subject: Subject,
  actionKey: string,
  resource: Resource,
  options: DecideOptions = {},
): Decision {
  const policy = options.policy ?? {};
  const now = options.now ?? new Date();
  const action = isActionKey(actionKey) ? actions[actionKey] : undefined;
  const consequential = action?.consequential === true;

  let auditReason: string | undefined;
  for (const g of guardrails) {
    const outcome = g.check({ subject, actionKey, action, resource, policy, now });
    if (outcome?.deny) return deny(`guardrail:${g.id}:${outcome.deny}`, consequential, g.id);
    if (outcome?.auditReason) auditReason = outcome.auditReason;
  }
  if (!action) return deny('unknown_action', consequential, 'G1');

  if (subject.kind === 'system') {
    const names = resource.fields?.map((f) => f.name) ?? [];
    return {
      effect: 'allow',
      reason: `system:${subject.job}`,
      fields: names,
      maskedFields: [],
      restrictedRead: [],
      consequential,
      recordScope: 'all',
    };
  }

  if (subject.kind === 'public') {
    const names = resource.fields?.map((f) => f.name) ?? [];
    return {
      effect: 'allow',
      reason: 'public',
      fields: names,
      maskedFields: [],
      restrictedRead: [],
      consequential,
      recordScope: 'all',
    };
  }

  if (subject.status !== 'active') return deny(`account_${subject.status}`, consequential);

  const allowedCategories = new Set<DataCategory>();
  let matched: ResolvedRole | undefined;
  let recordScope: Decision['recordScope'] = 'own';
  for (const role of subject.roles) {
    for (const grant of role.grants) {
      if (!actionMatches(grant.action, actionKey)) continue;
      if (!tenantInScope(grant, subject, resource, action.kind)) continue;
      if (!eventInScope(grant, role, resource)) continue;
      if (!recordInScope(grant, resource)) continue;
      matched ??= role;
      if ((grant.records ?? 'all') === 'all') recordScope = 'all';
      for (const c of grant.dataCategories ?? []) {
        // County-editable grants can never add a template-protected category.
        if (!TEMPLATE_PROTECTED_CATEGORIES.includes(c) && c !== 'cji') allowedCategories.add(c);
      }
    }
  }

  const qualified = qualifiedProtectedCategories(subject);

  if (matched) {
    const m = mask(resource.fields, allowedCategories, qualified);
    return {
      effect: 'allow',
      reason: `grant:${matched.key}@${matched.version}`,
      fields: m.fields,
      maskedFields: m.masked,
      restrictedRead: action.kind === 'read' ? m.restrictedRead : [],
      consequential,
      recordScope,
      ...(auditReason ? { auditReason } : {}),
    };
  }

  // SEC-08: break-glass is read-only, within the own tenant, and audited as restricted.
  const bg = subject.breakGlass;
  if (bg && bg.expiresAt.getTime() > now.getTime() && action.kind === 'read') {
    const target = resource.tenantId ?? subject.tenantId;
    if (target === subject.tenantId) {
      const everything = new Set<DataCategory>([
        'contact',
        'location_exact',
        'household',
        'free_text',
        'financial',
      ]);
      const m = mask(resource.fields, everything, qualified);
      return {
        effect: 'allow',
        reason: 'break_glass',
        fields: m.fields,
        maskedFields: m.masked,
        restrictedRead: m.restrictedRead,
        consequential,
        recordScope: 'all',
        auditReason: `break_glass:${bg.id}`,
      };
    }
  }

  return deny('no_grant', consequential);
}
