import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine.ts';
import { account, ALICE, BOB, role, TENANT_A } from './helpers.ts';

// 'report.approve' arrives with layer 2; the guardrail is wired now so the
// action cannot be added without it. Until then it is an unknown action and
// G1 denies first, so these tests exercise the guardrail directly through G4's
// own check as well as the engine order.
import { G4 } from '../src/guardrails.ts';

describe('G4 no approving your own finding (A7, BRD:FR-12.04, AC-12B)', () => {
  const reviewer = account([role([{ action: 'report.approve' }])]);
  const ownFinding = { type: 'report', tenantId: TENANT_A, recordedBy: ALICE };
  const othersFinding = { type: 'report', tenantId: TENANT_A, recordedBy: BOB };
  const base = {
    subject: reviewer,
    actionKey: 'report.approve',
    action: undefined,
    policy: {},
    now: new Date(),
  };

  it('denies approving a finding the same account recorded', () => {
    expect(G4.check({ ...base, resource: ownFinding })).toEqual({ deny: 'self_review' });
  });

  it('allows approving someone else’s finding', () => {
    expect(G4.check({ ...base, resource: othersFinding })).toBeUndefined();
  });

  it('with a tenant policy exception, passes but marks the audit reason', () => {
    expect(
      G4.check({ ...base, resource: ownFinding, policy: { selfReviewException: true } }),
    ).toEqual({
      auditReason: 'self_review_exception',
    });
  });

  it('is evaluated by the engine before grants', () => {
    const d = decide(reviewer, 'report.approve', ownFinding);
    expect(d.effect).toBe('deny');
    expect(['G1', 'G4']).toContain(d.guardrail);
  });
});
