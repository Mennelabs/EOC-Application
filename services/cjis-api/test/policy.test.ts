/**
 * The enclave policy (SEC-12, ADM-05, layer-5 plan §4): default deny, CJIS
 * qualification on every action but the caller's own account, agency scope,
 * audit immutability, a second administrator for role decisions, nobody
 * administering their own account, nobody reviewing their own disposition.
 */
import { describe, expect, it } from 'vitest';
import {
  ENCLAVE_ACTIONS,
  decide,
  qualification,
  type EnclaveSubject,
  type QualificationFacts,
} from '../src/policy.ts';

const today = new Date('2026-10-14T12:00:00Z');
const facts: QualificationFacts = {
  status: 'active',
  agencyStatus: 'active',
  fingerprintStatus: 'cleared',
  fingerprintAdjudicatedOn: new Date('2026-01-10'),
  trainingExpiresOn: new Date('2027-01-01'),
  roles: ['officer'],
};

const subject = (over: Partial<EnclaveSubject> = {}): EnclaveSubject => ({
  personId: 'p1',
  agencyId: 'a1',
  roles: ['officer'],
  qualified: true,
  missing: [],
  ...over,
});

describe('qualification (PS-3, AT-2)', () => {
  it('is complete with an active account, a cleared check, current training and a role', () => {
    expect(qualification(facts, today)).toEqual({ qualified: true, missing: [] });
  });

  it('names every missing piece', () => {
    const q = qualification(
      {
        status: 'suspended',
        agencyStatus: 'suspended',
        fingerprintStatus: 'pending',
        fingerprintAdjudicatedOn: null,
        trainingExpiresOn: null,
        roles: [],
      },
      today,
    );
    expect(q.qualified).toBe(false);
    expect(q.missing).toEqual([
      'account_not_active',
      'agency_not_active',
      'fingerprint_check',
      'security_training',
      'role',
    ]);
  });

  it('training stops counting on the day it expires', () => {
    expect(
      qualification({ ...facts, trainingExpiresOn: new Date('2026-10-14') }, today).missing,
    ).toEqual(['security_training']);
    expect(
      qualification({ ...facts, trainingExpiresOn: new Date('2026-10-15') }, today).qualified,
    ).toBe(true);
  });

  it('a cleared check without its adjudication date does not count', () => {
    expect(qualification({ ...facts, fingerprintAdjudicatedOn: null }, today).missing).toContain(
      'fingerprint_check',
    );
  });
});

describe('decide (ADM-05 in the enclave)', () => {
  it('E1: an unknown action is denied', () => {
    expect(decide(subject(), 'record.delete', { type: 'record' })).toMatchObject({
      effect: 'deny',
      reason: 'E1:unknown_action',
    });
  });

  it('E2: an unqualified person is denied every action but their own account', () => {
    const s = subject({ qualified: false, missing: ['security_training'] });
    expect(decide(s, 'record.read', { type: 'record', agencyId: 'a1' })).toMatchObject({
      effect: 'deny',
      visibleRefusal: true,
    });
    expect(decide(s, 'record.read', { type: 'record' }).reason).toContain('security_training');
    expect(decide(s, 'me.read', { type: 'person' }).effect).toBe('allow');
  });

  it('E3: another agency is denied', () => {
    expect(decide(subject(), 'record.read', { type: 'record', agencyId: 'a2' })).toMatchObject({
      effect: 'deny',
      reason: 'E3:other_agency',
    });
  });

  it('E3, mutual aid: a record shared with the subject’s agency may be read, never written', () => {
    const shared = { type: 'record', agencyId: 'a2', sharedWithSubject: true };
    expect(decide(subject(), 'record.read', shared).effect).toBe('allow');
    expect(decide(subject(), 'record.update', shared)).toMatchObject({ reason: 'E3:other_agency' });
    expect(decide(subject(), 'record.narrative', shared)).toMatchObject({
      reason: 'E3:other_agency',
    });
    expect(decide(subject({ roles: ['supervisor'] }), 'record.share', shared)).toMatchObject({
      reason: 'E3:other_agency',
    });
    // Only a supervisor or an administrator of the owning agency shares; it is consequential.
    expect(decide(subject(), 'record.share', { type: 'record', agencyId: 'a1' }).effect).toBe(
      'deny',
    );
    expect(
      decide(subject({ roles: ['supervisor'] }), 'record.share', {
        type: 'record',
        agencyId: 'a1',
      }),
    ).toMatchObject({ effect: 'allow', consequential: true });
    // An unqualified officer reads nothing through a share either (E2 first).
    expect(
      decide(subject({ qualified: false, missing: ['security_training'] }), 'record.read', shared)
        .effect,
    ).toBe('deny');
  });

  it('E4: nobody writes the audit, not even a security officer', () => {
    const s = subject({ roles: ['security_officer'] });
    expect(decide(s, 'audit.review', { type: 'audit_event' }).reason).toBe('E4:audit_immutable');
    expect(decide(s, 'audit.read', { type: 'audit_event' }).effect).toBe('allow');
  });

  it('E5: a second administrator decides; nobody decides their own request or about themselves', () => {
    const admin = subject({ roles: ['agency_admin'] });
    expect(
      decide(admin, 'permission.decide', { type: 'permission_request', requestedBy: 'p1' }).reason,
    ).toBe('E5:second_administrator_required');
    expect(
      decide(admin, 'permission.decide', {
        type: 'permission_request',
        requestedBy: 'p2',
        aboutPersonId: 'p1',
      }).reason,
    ).toBe('E5:own_account');
    expect(
      decide(admin, 'permission.decide', {
        type: 'permission_request',
        requestedBy: 'p2',
        aboutPersonId: 'p3',
      }).effect,
    ).toBe('allow');
    expect(decide(admin, 'account.screening', { type: 'person', aboutPersonId: 'p1' }).reason).toBe(
      'E5:own_account',
    );
  });

  it('E6: nobody reviews their own disposition', () => {
    const sup = subject({ roles: ['supervisor'] });
    expect(decide(sup, 'record.review', { type: 'record', recordedBy: 'p1' }).reason).toBe(
      'E6:own_disposition',
    );
    expect(decide(sup, 'record.review', { type: 'record', recordedBy: 'p9' }).effect).toBe('allow');
  });

  it('roles: records for record workers, the audit for auditors, accounts for administrators', () => {
    expect(decide(subject({ roles: ['auditor'] }), 'record.read', { type: 'record' }).effect).toBe(
      'deny',
    );
    expect(
      decide(subject({ roles: ['auditor'] }), 'audit.read', { type: 'audit_event' }).effect,
    ).toBe('allow');
    expect(decide(subject({ roles: ['officer'] }), 'account.read', { type: 'person' }).effect).toBe(
      'deny',
    );
    expect(
      decide(subject({ roles: ['records_clerk'] }), 'record.disposition', { type: 'record' })
        .effect,
    ).toBe('deny');
  });

  it('consequential actions are flagged for confirmation (RULE-14)', () => {
    expect(decide(subject(), 'record.disposition', { type: 'record' }).consequential).toBe(true);
    for (const key of ['account.suspend', 'permission.decide', 'audit.export', 'hold.release'])
      expect(ENCLAVE_ACTIONS[key as keyof typeof ENCLAVE_ACTIONS].consequential).toBe(true);
  });

  it('there is no break-glass: no action is allowed without a role', () => {
    expect(decide(subject({ roles: [] }), 'record.read', { type: 'record' }).effect).toBe('deny');
  });
});
