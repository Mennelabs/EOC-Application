import { describe, expect, it } from 'vitest';
import { actions } from '../src/actions.ts';
import { decide } from '../src/engine.ts';
import { account, role, TENANT_A } from './helpers.ts';

describe('G5 nobody edits or deletes audit records (BRD:FR-08.04, RULE-15)', () => {
  const admin = account([role([{ action: '*' }])]);

  it('the catalog has no write action on audit records', () => {
    const writes = Object.entries(actions).filter(
      ([, m]) => m.resource === 'audit_event' && m.kind !== 'read' && m.kind !== 'export',
    );
    expect(writes).toEqual([]);
  });

  it('a wildcard admin may read and export, never change', () => {
    expect(decide(admin, 'audit.read', { type: 'audit_event', tenantId: TENANT_A }).effect).toBe(
      'allow',
    );
    expect(decide(admin, 'audit.export', { type: 'audit_event', tenantId: TENANT_A }).effect).toBe(
      'allow',
    );
    for (const bogus of ['audit.update', 'audit.delete', 'audit.truncate']) {
      expect(decide(admin, bogus, { type: 'audit_event', tenantId: TENANT_A }).effect).toBe('deny');
    }
  });

  it('refuses a write-kind action pointed at an audit resource', () => {
    // definition.write is an admin action; targeting an audit_event with it is refused by G5.
    const d = decide(admin, 'definition.write', { type: 'audit_event', tenantId: TENANT_A });
    expect(d.reason).toBe('guardrail:G5:audit_immutable');
  });
});
