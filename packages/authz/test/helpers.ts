import type {
  AccountSubject,
  FieldDescriptor,
  Grant,
  ResolvedRole,
  Resource,
} from '../src/types.ts';

export const TENANT_A = '00000000-0000-0000-0000-00000000000a';
export const TENANT_B = '00000000-0000-0000-0000-00000000000b';
export const PATH_A = 'state.a';
export const ALICE = '00000000-0000-0000-0000-0000000a11ce';
export const BOB = '00000000-0000-0000-0000-000000000b0b';

export function role(grants: Grant[], extra: Partial<ResolvedRole> = {}): ResolvedRole {
  return {
    roleId: 'r1',
    key: 'test_role',
    version: 1,
    templateKey: null,
    grants,
    scope: {},
    ...extra,
  };
}

export function account(
  roles: ResolvedRole[],
  extra: Partial<AccountSubject> = {},
): AccountSubject {
  return {
    kind: 'account',
    accountId: ALICE,
    tenantId: TENANT_A,
    tenantPath: PATH_A,
    status: 'active',
    roles,
    resolvedAt: new Date(),
    ...extra,
  };
}

export const eventInA: Resource = {
  type: 'event',
  id: 'e1',
  tenantId: TENANT_A,
  tenantPath: PATH_A,
};

export const personnelFields: FieldDescriptor[] = [
  { name: 'name', category: 'basic', classification: 'sensitive' },
  { name: 'phone', category: 'contact', classification: 'restricted' },
  { name: 'medications', category: 'health', classification: 'restricted' },
  { name: 'counseling_notes', category: 'counseling', classification: 'restricted' },
  { name: 'legal_notes', category: 'legal', classification: 'restricted' },
  { name: 'arrest_disposition', category: 'cji', classification: 'cji' },
];
