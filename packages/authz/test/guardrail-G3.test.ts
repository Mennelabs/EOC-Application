import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine.ts';
import { account, personnelFields, role, TENANT_A } from './helpers.ts';

describe('G3 criminal-justice data only for CJIS enclave sessions (SEC-12)', () => {
  const admin = account([role([{ action: '*', dataCategories: ['contact'] }])]);

  it('denies any action on a cji resource type without an enclave session', () => {
    const d = decide(admin, 'event.read', { type: 'cji_mission_detail', tenantId: TENANT_A });
    expect(d.reason).toBe('guardrail:G3:cji_requires_enclave_session');
  });

  it('denies when a requested field is classified cji', () => {
    const d = decide(admin, 'personnel.read', {
      type: 'personnel',
      tenantId: TENANT_A,
      fields: personnelFields,
    });
    expect(d.guardrail).toBe('G3');
  });

  it('a grant naming the cji category changes nothing', () => {
    const d = decide(
      account([role([{ action: '*', dataCategories: ['cji'] }])]),
      'personnel.read',
      { type: 'personnel', tenantId: TENANT_A, fields: personnelFields },
    );
    expect(d.guardrail).toBe('G3');
  });

  it('passes only for a verified enclave session, and even then masks nothing extra', () => {
    const d = decide(
      account([role([{ action: 'personnel.read' }])], { enclaveSession: true }),
      'personnel.read',
      { type: 'personnel', tenantId: TENANT_A, fields: personnelFields },
    );
    expect(d.effect).toBe('allow');
    // The platform engine still never returns a cji field; the enclave API has its own.
    expect(d.fields).not.toContain('arrest_disposition');
  });
});
